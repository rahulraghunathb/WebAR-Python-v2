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
    if (profile && profile.name) {
      return String(profile.name)
    }
    const url = profile && profile.targetImageUrl ? String(profile.targetImageUrl) : ''
    if (!url) {
      return '-'
    }
    const parts = url.split('/')
    return parts[parts.length - 1] || url
  }

  resolveTargetIndex(profileInput) {
    const profile = profileInput || this.targetProfile || this.getTargetProfile()
    if (
      window.ModelTransformHelpers &&
      typeof window.ModelTransformHelpers.getProfileIndex === 'function'
    ) {
      return Number(window.ModelTransformHelpers.getProfileIndex(profile && profile.id))
    }
    return 0
  }

  getTargetProfile() {
    if (
      window.ModelTransformHelpers &&
      typeof window.ModelTransformHelpers.getProfile === 'function'
    ) {
      this.targetProfile = window.ModelTransformHelpers.getProfile()
    } else if (!this.targetProfile) {
      this.targetProfile = {
        id: 'default-target',
        name: 'Configured Target',
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
    this.metrics.targetIndex = this.resolveTargetIndex(this.targetProfile)
    const secureContext = typeof window !== 'undefined' ? Boolean(window.isSecureContext) : false
    const protocol = typeof window !== 'undefined' && window.location ? window.location.protocol : ''
    const userAgent = typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : ''
    const isiPhoneFamily = /iPhone|iPad|iPod/i.test(userAgent)
    const isWebKitBrowser = /AppleWebKit/i.test(userAgent) && !/CriOS|FxiOS/i.test(userAgent)

    if (!secureContext) {
      this.metrics.supportState = 'UNAVAILABLE'
      return {
        supported: false,
        reason:
          'This page is not running in a secure context. Open it over HTTPS or localhost to access AR browser APIs.',
      }
    }

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
        reason: isiPhoneFamily || isWebKitBrowser
          ? 'This browser is not exposing WebXR raw camera access. On iPhone/iPad browsers, immersive WebXR is usually unavailable.'
          : 'WebXR raw camera access is not exposed in this browser. Try a compatible AR browser over HTTPS.',
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
        reason: isiPhoneFamily || isWebKitBrowser
          ? 'WebXR is not available in this browser. On iPhone/iPad browsers, immersive WebXR support is usually missing.'
          : protocol === 'https:'
            ? 'WebXR is not available in this browser.'
            : 'WebXR is unavailable here. A secure HTTPS origin and a compatible browser are required.',
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
    this.metrics.targetIndex = this.resolveTargetIndex(profile)
    this.metrics.targetState = 'LOADED'
    return this.targetImageBitmap
  }

  async sendTargetReferenceToWorker() {
    if (!this.poseWorker || !this.poseWorkerReady) {
      throw new Error('Pose worker is not ready for reference upload.')
    }

    const bitmap = this.targetImageBitmap || (await this.loadTargetReferenceImage())
    const maxDimension = 320
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
      this.metrics.framebufferScale = 1
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
        this.renderer.xr.setReferenceSpaceType('local')
        this.metrics.referenceSpace = 'local-bootstrap'
        this.log('Configured Three XR reference space type', { type: 'local' })
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
