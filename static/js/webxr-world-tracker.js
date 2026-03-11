class WebXRWorldTracker {
  constructor(options = {}) {
    this.modelRenderer = options.modelRenderer || null
    this.cameraPipeline = options.cameraPipeline || null
    this.overlayRoot = options.overlayRoot || document.body
    this.onLog = typeof options.onLog === 'function' ? options.onLog : null
    this.onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : null

    this.session = null
    this.referenceSpace = null
    this.renderer = null
    this.scene = null
    this.camera = null
    this.viewportStage = document.getElementById('viewportStage') || null

    this.targetProfile = null
    this.targetImageBitmap = null

    this.poseWorker = null
    this.poseWorkerReady = false
    this.poseWorkerInitPromise = null
    this.poseWorkerInitResolve = null
    this.poseWorkerInitReject = null
    this.poseWorkerInitTimeoutId = 0

    this.filteredPlacementMatrix = null
    this.state = 'IDLE'
    this.lastFrameTime = 0
    this.lastFpsSampleTime = 0
    this.frameCount = 0

    this.metrics = {
      supportState: 'PENDING',
      sessionState: 'IDLE',
      visibilityState: document.visibilityState || 'hidden',
      worldState: 'IDLE',
      targetState: 'IDLE',
      targetName: '-',
      targetVisible: false,
      targetUpdates: 0,
      targetMeasuredWidthM: 0,
      targetIndex: -1,
      targetMatchCount: 0,
      targetInlierCount: 0,
      targetConfidence: 0,
      targetReprojectionPx: 0,
      targetReferenceReady: false,
      targetReferenceFeatures: 0,
      referenceSpace: '-',
      hitTestState: 'DISABLED',
      anchorState: 'UNAVAILABLE',
      anchorSupported: false,
      domOverlayState: 'REQUESTED',
      lightEstimationState: 'UNREQUESTED',
      surfaceHits: 0,
      selectCount: 0,
      placementCount: 0,
      lastHitDistanceM: 0,
      viewport: '-',
      frameTimeMs: 16.7,
      xrFps: 0,
      localLatencyMs: 0,
      hasPlacement: false,
      workerState: 'IDLE',
      wasmState: 'IDLE',
      filterSource: 'NONE',
      filterConfidence: 0,
      measurementConfidence: 0,
      baseMeasurementConfidence: 0,
      visualQuality: 0,
      workerProcMs: 0,
      workerLatencyMs: 0,
      residualTranslationM: 0,
      residualRotationDeg: 0,
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
      visualCaptureMs: 0,
      visualProcMs: 0,
      trackCount: 0,
      matchCount: 0,
      matchRatio: 0,
      trackConfidence: 0,
      keyframeCount: 0,
      landmarkCount: 0,
      mapState: 'BOOTSTRAP',
      relocalizationScore: 0,
      relocalizationKeyframeId: -1,
      motionVectorX: 0,
      motionVectorY: 0,
      motionScale: 1,
      motionRotationDeg: 0,
      visualOdometryConfidence: 0,
      cameraAccessState: 'IDLE',
      cameraCaptures: 0,
      cameraSkippedThrottle: 0,
      cameraSkippedBusy: 0,
      cameraLastCaptureMs: 0,
      cameraAverageCaptureMs: 0,
      cameraCaptureIntervalMs: 0,
      cameraCaptureMaxDimension: 0,
      cameraFramePending: false,
      framebufferScale: 1,
    }

    this.boundSessionEnd = () => this.handleSessionEnd()
    this.boundVisibilityChange = () => this.handleVisibilityChange()
  }

  log(message, data) {
    if (this.onLog) {
      this.onLog(message, data)
      return
    }
    if (typeof data === 'undefined') {
      console.info('[WebXR]', message)
      return
    }
    console.info('[WebXR]', message, data)
  }

  resolveTargetName() {
    const profile = this.targetProfile || this.getTargetProfile()
    const url = profile && profile.targetImageUrl ? String(profile.targetImageUrl) : ''
    if (!url) {
      return '-'
    }
    const parts = url.split('/')
    return parts[parts.length - 1] || url
  }

  getTargetProfile() {
    if (
      window.ModelTransformHelpers &&
      typeof window.ModelTransformHelpers.getProfile === 'function'
    ) {
      this.targetProfile = window.ModelTransformHelpers.getProfile()
    } else if (!this.targetProfile) {
      this.targetProfile = {
        targetImageUrl: '',
        targetPhysicalWidthMeters: 0.2,
      }
    }
    return this.targetProfile
  }

  syncCameraDiagnostics() {
    if (!this.cameraPipeline || typeof this.cameraPipeline.getDiagnostics !== 'function') {
      return
    }

    const camera = this.cameraPipeline.getDiagnostics()
    this.metrics.cameraCaptures = Number(camera.captures || 0)
    this.metrics.cameraSkippedThrottle = Number(camera.skippedThrottle || 0)
    this.metrics.cameraSkippedBusy = Number(camera.skippedBusy || 0)
    this.metrics.cameraLastCaptureMs = Number(camera.lastCaptureMs || 0)
    this.metrics.cameraAverageCaptureMs = Number(camera.averageCaptureMs || 0)
    this.metrics.cameraCaptureIntervalMs = Number(camera.minFrameIntervalMs || 0)
    this.metrics.cameraCaptureMaxDimension = Number(camera.maxDimension || 0)
    this.metrics.cameraFramePending = Boolean(camera.inFlight)

    if (camera.outputWidth && camera.outputHeight) {
      this.metrics.visualFrameSize = camera.outputWidth + 'x' + camera.outputHeight
    }

    if (
      this.metrics.cameraAccessState !== 'ERROR' &&
      camera.state &&
      camera.state !== 'IDLE'
    ) {
      this.metrics.cameraAccessState = camera.state
    }
  }

  emitState() {
    this.syncCameraDiagnostics()
    if (this.onStateChange) {
      this.onStateChange(this.state, this.getDiagnostics())
    }
  }

  setState(state) {
    if (this.state === state) {
      return
    }
    this.state = state
    this.metrics.worldState = state
    if (this.modelRenderer) {
      this.modelRenderer.setWorldTrackingState(state)
    }
    this.emitState()
  }

  clearLatestHit() {
    this.metrics.surfaceHits = 0
    this.metrics.lastHitDistanceM = 0
    this.metrics.hitTestState = 'DISABLED'
  }

  async checkSupport() {
    this.getTargetProfile()
    this.metrics.targetName = this.resolveTargetName()
    this.metrics.targetMeasuredWidthM = Number(
      this.targetProfile && this.targetProfile.targetPhysicalWidthMeters
        ? this.targetProfile.targetPhysicalWidthMeters
        : 0
    )
    this.metrics.targetIndex = 0

    if (typeof Worker === 'undefined') {
      this.metrics.supportState = 'UNAVAILABLE'
      return {
        supported: false,
        reason: 'Web Worker support is required for the tracking pipeline.',
      }
    }

    if (typeof WebAssembly === 'undefined') {
      this.metrics.supportState = 'UNAVAILABLE'
      return {
        supported: false,
        reason: 'WebAssembly support is required for the tracking pipeline.',
      }
    }

    if (typeof createImageBitmap !== 'function') {
      this.metrics.supportState = 'UNAVAILABLE'
      return {
        supported: false,
        reason: 'ImageBitmap support is required for the target reference pipeline.',
      }
    }

    if (typeof XRWebGLBinding === 'undefined') {
      this.metrics.supportState = 'UNAVAILABLE'
      return {
        supported: false,
        reason: 'WebXR raw camera access is required for visual ingestion.',
      }
    }

    if (!this.cameraPipeline || !this.cameraPipeline.checkSupport()) {
      this.metrics.supportState = 'UNAVAILABLE'
      return {
        supported: false,
        reason: 'XR raw camera access is required for the visual analysis pipeline.',
      }
    }

    if (!navigator.xr) {
      this.metrics.supportState = 'UNAVAILABLE'
      return {
        supported: false,
        reason: 'WebXR is not available in this browser.',
      }
    }

    try {
      const supported = await navigator.xr.isSessionSupported('immersive-ar')
      this.metrics.supportState = supported ? 'SUPPORTED' : 'UNAVAILABLE'
      return {
        supported: supported,
        reason: supported ? '' : 'immersive-ar is not supported on this device.',
      }
    } catch (error) {
      this.metrics.supportState = 'UNAVAILABLE'
      return {
        supported: false,
        reason: error.message || 'Failed to query immersive-ar support.',
      }
    }
  }

  ensureSceneContext() {
    if (!this.modelRenderer || typeof this.modelRenderer.getSceneContext !== 'function') {
      throw new Error('Model renderer scene context is unavailable.')
    }

    const context = this.modelRenderer.getSceneContext()
    if (!context || !context.renderer || !context.scene || !context.camera) {
      throw new Error('Model renderer scene context is incomplete.')
    }

    this.renderer = context.renderer
    this.scene = context.scene
    this.camera = context.camera
    return context
  }

  async acquireReferenceSpace() {
    if (!this.session) {
      throw new Error('XR session is not active.')
    }

    const candidates = ['local', 'local-floor', 'unbounded', 'viewer']
    let lastError = null
    for (const type of candidates) {
      try {
        const referenceSpace = await this.session.requestReferenceSpace(type)
        this.metrics.referenceSpace = type
        this.log('XR reference space acquired', { type })
        return referenceSpace
      } catch (error) {
        lastError = error
        this.log('XR reference space unavailable', {
          type,
          message: error.message || 'Unsupported reference space type.',
        })
      }
    }

    throw new Error(
      lastError && lastError.message
        ? lastError.message
        : 'This device does not support a usable XR reference space type.'
    )
  }

  async loadTargetReferenceImage() {
    const profile = this.getTargetProfile()
    if (!profile.targetImageUrl) {
      throw new Error('Target image URL is not configured.')
    }

    const response = await fetch(profile.targetImageUrl, { cache: 'no-store' })
    if (!response.ok) {
      throw new Error('Failed to load target image reference (' + response.status + ').')
    }

    const blob = await response.blob()
    if (this.targetImageBitmap && typeof this.targetImageBitmap.close === 'function') {
      this.targetImageBitmap.close()
    }

    this.targetImageBitmap = await createImageBitmap(blob)
    this.metrics.targetName = this.resolveTargetName()
    this.metrics.targetMeasuredWidthM = Number(profile.targetPhysicalWidthMeters || 0)
    this.metrics.targetIndex = 0
    this.metrics.targetState = 'LOADED'
    return this.targetImageBitmap
  }

  async sendTargetReferenceToWorker() {
    if (!this.poseWorker || !this.poseWorkerReady) {
      throw new Error('Pose worker is not ready for reference upload.')
    }

    const bitmap = this.targetImageBitmap || (await this.loadTargetReferenceImage())
    const maxDimension = 192
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(24, Math.round(bitmap.width * scale))
    const height = Math.max(24, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) {
      throw new Error('2D canvas is unavailable for target reference preparation.')
    }

    context.drawImage(bitmap, 0, 0, width, height)
    const imageData = context.getImageData(0, 0, width, height)
    const physicalWidthM = Number(this.targetProfile.targetPhysicalWidthMeters || 0.2)
    const physicalHeightM = Number((physicalWidthM * height) / Math.max(1, width))

    this.metrics.targetState = 'LOADING'
    this.metrics.targetReferenceReady = false
    this.metrics.targetReferenceFeatures = 0
    this.emitState()

    this.poseWorker.postMessage(
      {
        type: 'reference-image',
        payload: {
          name: this.resolveTargetName(),
          width,
          height,
          physicalWidthM,
          physicalHeightM,
          pixels: imageData.data.buffer,
        },
      },
      [imageData.data.buffer]
    )

    this.log('Uploaded target reference to worker', {
      width,
      height,
      physicalWidthM: Number(physicalWidthM.toFixed(3)),
      physicalHeightM: Number(physicalHeightM.toFixed(3)),
    })
  }

  async setupPoseWorker() {
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
        referenceMaxDimension: 192,
        minTargetMatches: 8,
        minTargetInliers: 6,
        targetInlierPx: 7,
        targetRansacIterations: 56,
      },
    })

    return this.poseWorkerInitPromise
  }

  handlePoseWorkerFailure(message) {
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
  }

  destroyPoseWorker() {
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
  }

  handlePoseWorkerMessage(event) {
    const data = event.data || {}
    const payload = data.payload || {}

    if (data.type === 'reference-ready') {
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
      return
    }

    if (data.type === 'pose-update') {
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
      return
    }

    if (data.type === 'visual-update') {
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
      this.metrics.matchCount = Number(payload.matchCount || 0)
      this.metrics.matchRatio = Number(payload.matchRatio || 0)
      this.metrics.trackConfidence = Number(payload.trackConfidence || 0)
      this.metrics.keyframeCount = Number(payload.keyframeCount || 0)
      this.metrics.landmarkCount = Number(payload.landmarkCount || 0)
      this.metrics.mapState = payload.mapState || this.metrics.mapState
      this.metrics.relocalizationScore = Number(payload.relocalizationScore || 0)
      this.metrics.relocalizationKeyframeId = Number(payload.relocalizationKeyframeId || -1)
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
      this.metrics.targetConfidence = Number(payload.targetConfidence || 0)
      this.metrics.targetReprojectionPx = Number(payload.targetReprojectionPx || 0)
      this.metrics.targetUpdates = Number(payload.targetUpdates || 0)
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
      return
    }

    if (data.type === 'reset-complete') {
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
  }

  postVisualFrame(capture, viewerPose) {
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
  }

  resetPlacement() {
    this.filteredPlacementMatrix = null
    this.metrics.hasPlacement = false
    this.metrics.targetVisible = false
    this.metrics.targetState = this.metrics.targetReferenceReady
      ? this.session
        ? 'SEARCHING'
        : 'READY'
      : 'UNINITIALIZED'
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
    this.modelRenderer.clearWorldPlacement()

    if (this.poseWorker && this.poseWorkerReady) {
      this.poseWorker.postMessage({ type: 'reset' })
    }

    if (this.session) {
      this.setState('SCANNING')
    } else {
      this.setState('IDLE')
    }
    this.emitState()
    this.log('Target lock reset')
  }

  async start() {
    if (this.session) {
      return
    }

    let startedSession = null
    try {
      this.ensureSceneContext()
      const support = await this.checkSupport()
      if (!support.supported) {
        throw new Error(support.reason)
      }

      await this.setupPoseWorker()
      await this.loadTargetReferenceImage()
      await this.sendTargetReferenceToWorker()

      this.metrics.sessionState = 'STARTING'
      this.metrics.cameraAccessState = 'STARTING'
      this.metrics.visibilityState = document.visibilityState || 'visible'
      this.metrics.targetState = this.metrics.targetReferenceReady ? 'SEARCHING' : 'LOADING'
      this.metrics.hitTestState = 'DISABLED'
      this.metrics.anchorState = 'IMAGE_TARGET'
      this.metrics.referenceSpace = 'NEGOTIATING'
      this.metrics.framebufferScale = 1.15
      this.emitState()

      startedSession = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['camera-access'],
        optionalFeatures: ['dom-overlay', 'light-estimation'],
        domOverlay: { root: this.overlayRoot },
      })

      this.session = startedSession
      this.session.addEventListener('end', this.boundSessionEnd)
      document.addEventListener('visibilitychange', this.boundVisibilityChange)

      this.renderer.xr.enabled = true
      if (this.renderer.xr && typeof this.renderer.xr.setReferenceSpaceType === 'function') {
        this.renderer.xr.setReferenceSpaceType('viewer')
        this.metrics.referenceSpace = 'viewer-bootstrap'
        this.log('Configured Three XR reference space type', { type: 'viewer' })
      }
      if (typeof this.renderer.xr.setFramebufferScaleFactor === 'function') {
        this.renderer.xr.setFramebufferScaleFactor(this.metrics.framebufferScale)
      }
      await this.renderer.xr.setSession(this.session)

      await this.cameraPipeline.start(this.session, this.renderer)
      this.referenceSpace = null
      this.metrics.referenceSpace = 'renderer-pending'
      this.modelRenderer.setXRSessionActive(true)
      this.modelRenderer.clearWorldPlacement()

      this.metrics.sessionState = 'ACTIVE'
      this.metrics.cameraAccessState = 'READY'
      this.metrics.targetState = this.metrics.targetReferenceReady ? 'SEARCHING' : 'LOADING'
      this.metrics.targetVisible = false
      this.metrics.hasPlacement = false
      this.metrics.placementCount = 0
      this.metrics.selectCount = 0
      this.metrics.anchorState = 'IMAGE_TARGET'
      this.lastFrameTime = 0
      this.lastFpsSampleTime = performance.now()
      this.frameCount = 0

      if (this.poseWorker && this.poseWorkerReady) {
        this.poseWorker.postMessage({ type: 'reset' })
      }

      this.renderer.setAnimationLoop((time, frame) => {
        this.onXRFrame(time, frame)
      })

      this.log('XR session started with owned target tracker', {
        target: this.metrics.targetName,
        framebufferScale: this.metrics.framebufferScale,
        captureIntervalMs: this.metrics.cameraCaptureIntervalMs,
        captureMaxDimension: this.metrics.cameraCaptureMaxDimension,
      })
      this.setState('SCANNING')
    } catch (error) {
      const normalizedMessage = error.message || 'Failed to start camera-access XR session.'
      this.metrics.sessionState = 'ERROR'
      if (this.metrics.referenceSpace !== 'renderer-default') {
        this.metrics.referenceSpace = 'FAILED'
      }
      this.metrics.cameraAccessState = 'ERROR'
      this.metrics.visibilityState = document.visibilityState || 'visible'
      this.modelRenderer.setXRSessionActive(false)
      if (startedSession && typeof startedSession.end === 'function') {
        try {
          await startedSession.end()
        } catch (sessionEndError) {
          this.log('XR cleanup after failed start also failed', {
            message: sessionEndError.message,
          })
        }
      }
      this.destroyPoseWorker()
      this.setState('ERROR')
      throw new Error(normalizedMessage)
    }
  }

  async stop() {
    if (this.session) {
      await this.session.end()
      return
    }
    this.handleSessionEnd()
  }

  handleVisibilityChange() {
    this.metrics.visibilityState = document.visibilityState || 'hidden'
    this.emitState()
  }

  onXRFrame(time, frame) {
    if (!frame) {
      return
    }

    if (!this.referenceSpace) {
      const rendererReferenceSpace =
        this.renderer &&
        this.renderer.xr &&
        typeof this.renderer.xr.getReferenceSpace === 'function'
          ? this.renderer.xr.getReferenceSpace()
          : null
      if (rendererReferenceSpace) {
        this.referenceSpace = rendererReferenceSpace
        this.metrics.referenceSpace = 'renderer-default'
        this.log('Using renderer-managed XR reference space')
        this.emitState()
      }
    }

    const frameStartedAt = performance.now()
    if (!this.referenceSpace) {
      this.metrics.hitTestState = 'NO_REF_SPACE'
      this.modelRenderer.render()
      this.metrics.localLatencyMs = Number((performance.now() - frameStartedAt).toFixed(3))
      return
    }
    const deltaMs = this.lastFrameTime ? Math.max(1, time - this.lastFrameTime) : 16.7
    this.lastFrameTime = time
    this.metrics.frameTimeMs = Number(deltaMs.toFixed(2))
    this.frameCount += 1

    const now = performance.now()
    if (!this.lastFpsSampleTime) {
      this.lastFpsSampleTime = now
    } else if (now - this.lastFpsSampleTime >= 1000) {
      this.metrics.xrFps = Math.round((this.frameCount * 1000) / (now - this.lastFpsSampleTime))
      this.frameCount = 0
      this.lastFpsSampleTime = now
    }

    this.modelRenderer.markWorldFrame(deltaMs)

    const viewerPose = frame.getViewerPose(this.referenceSpace)
    if (!viewerPose || !viewerPose.views || !viewerPose.views.length) {
      this.metrics.hitTestState = 'NO_POSE'
      if (!this.metrics.hasPlacement) {
        this.setState('SCANNING')
      }
      this.modelRenderer.render()
      this.metrics.localLatencyMs = Number((performance.now() - frameStartedAt).toFixed(3))
      return
    }

    this.metrics.hitTestState = 'DISABLED'
    this.updateViewport(viewerPose.views[0])
    this.captureVisualFrame(frame, viewerPose)
    this.modelRenderer.render()
    this.metrics.localLatencyMs = Number((performance.now() - frameStartedAt).toFixed(3))
  }

  captureVisualFrame(frame, viewerPose) {
    if (!this.cameraPipeline || !this.poseWorkerReady) {
      return
    }

    const capture = this.cameraPipeline.captureFrame(frame, viewerPose)
    this.syncCameraDiagnostics()
    if (!capture) {
      return
    }

    const posted = this.postVisualFrame(capture, viewerPose)
    if (posted) {
      this.cameraPipeline.markFrameSubmitted()
    } else {
      this.cameraPipeline.markFrameComplete()
    }
    this.syncCameraDiagnostics()
  }

  updateViewport(view) {
    const rect = this.viewportStage
      ? this.viewportStage.getBoundingClientRect()
      : { width: window.innerWidth, height: window.innerHeight }
    const width = Math.max(1, Math.round(rect.width || window.innerWidth))
    const height = Math.max(1, Math.round(rect.height || window.innerHeight))
    const sourceWidth = Number((view && view.camera && view.camera.width) || 0)
    const sourceHeight = Number((view && view.camera && view.camera.height) || 0)

    this.metrics.viewport = width + 'x' + height
    this.modelRenderer.resize(width, height, {
      sourceWidth,
      sourceHeight,
      fitMode: 'cover',
    })
  }

  handleSessionEnd() {
    if (this.session) {
      this.session.removeEventListener('end', this.boundSessionEnd)
    }
    document.removeEventListener('visibilitychange', this.boundVisibilityChange)

    if (this.renderer) {
      this.renderer.setAnimationLoop(null)
      this.renderer.xr.enabled = false
    }

    if (this.cameraPipeline) {
      this.cameraPipeline.stop()
      this.syncCameraDiagnostics()
    }

    this.referenceSpace = null
    this.session = null
    this.lastFrameTime = 0
    this.lastFpsSampleTime = 0
    this.frameCount = 0
    this.filteredPlacementMatrix = null
    this.clearLatestHit()

    if (this.targetImageBitmap && typeof this.targetImageBitmap.close === 'function') {
      this.targetImageBitmap.close()
    }
    this.targetImageBitmap = null

    this.modelRenderer.setXRSessionActive(false)
    this.modelRenderer.resetPose()
    this.destroyPoseWorker()

    this.metrics.sessionState = 'ENDED'
    this.metrics.visibilityState = 'hidden'
    this.metrics.targetState = 'IDLE'
    this.metrics.targetVisible = false
    this.metrics.targetUpdates = 0
    this.metrics.targetMatchCount = 0
    this.metrics.targetInlierCount = 0
    this.metrics.targetConfidence = 0
    this.metrics.targetReprojectionPx = 0
    this.metrics.targetReferenceReady = false
    this.metrics.targetReferenceFeatures = 0
    this.metrics.targetIndex = -1
    this.metrics.hasPlacement = false
    this.metrics.anchorState = 'UNAVAILABLE'
    this.metrics.cameraAccessState = 'IDLE'
    this.metrics.visualState = 'IDLE'
    this.metrics.visualFrames = 0
    this.metrics.visualQuality = 0
    this.metrics.visualFeatureCount = 0
    this.metrics.trackCount = 0
    this.metrics.matchCount = 0
    this.metrics.keyframeCount = 0
    this.metrics.landmarkCount = 0
    this.metrics.mapState = 'BOOTSTRAP'
    this.metrics.relocalizationScore = 0
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
    this.metrics.framebufferScale = 1
    this.metrics.xrFps = 0
    this.metrics.viewport = '-'
    this.metrics.referenceSpace = '-'
    this.metrics.localLatencyMs = 0

    this.setState('ENDED')
    this.log('XR session ended')
  }

  getDiagnostics() {
    this.syncCameraDiagnostics()
    return {
      ...this.metrics,
      state: this.state,
      sessionActive: Boolean(this.session),
      poseWorkerReady: this.poseWorkerReady,
    }
  }
}

window.WebXRWorldTracker = WebXRWorldTracker








