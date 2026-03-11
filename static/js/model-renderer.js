/**
 * Three.js renderer for development AR tracking experiments.
 *
 * The renderer still supports legacy vision-pose smoothing, but the active runtime
 * now uses filtered world-space placement from the browser-side worker + WASM pose layer.
 */

class ModelRenderer {
  constructor(canvasId) {
    this.canvasId = canvasId || 'threeCanvas'
    this.canvas = null
    this.scene = null
    this.camera = null
    this.renderer = null
    this.trackingRoot = null

    this.modelRoot = null
    this.modelLoaded = false
    this.modelMetadata = null
    this.modelReadyResolvers = []

    this.fov = 60
    this.fovLocked = false
    this.intrinsicsFingerprint = null

    this.imuManager = null
    this.imuHistory = new Map()

    this.currentVisionPosition = new THREE.Vector3()
    this.currentVisionQuaternion = new THREE.Quaternion()
    this.renderedPosition = new THREE.Vector3()
    this.renderedQuaternion = new THREE.Quaternion()
    this.previousRenderedPosition = new THREE.Vector3()
    this.visionVelocity = new THREE.Vector3()
    this.visionIMUQuaternion = null

    this.hasVisionPose = false
    this.isTracking = false
    this.lastVisionTime = 0
    this.lastGapTime = 0
    this.lastRenderTime = performance.now()
    this.predictionMaxMs = 420
    this.xrSessionActive = false
    this.worldPlacementActive = false
    this.worldTrackingState = 'IDLE'
    this.translationPredictionWindowMs = 140
    this.reacquireSnapMs = 260

    this.debugMode = true
    this.debugObjects = {}
    this.renderStats = {
      poseQuality: 0,
      poseAgeMs: 0,
      translationJumpM: 0,
      rotationJumpDeg: 0,
      renderJitterMm: 0,
      lastFrameMs: 16.7,
      predictionActive: false,
      acceptedVisionUpdates: 0,
      rejectedVisionUpdates: 0,
      lastPoseSource: 'SEARCHING',
      lastRejectedReason: 'NONE',
      lastConfidence: 0,
      visionVelocity: 0,
    }

    this.init()
  }

  setLogger(onLog) {
    this.onLog = typeof onLog === 'function' ? onLog : null
  }

  log(message, data) {
    if (this.onLog) {
      this.onLog(message, data)
      return
    }
    if (typeof data === 'undefined') {
      console.info('[Renderer]', message)
      return
    }
    console.info('[Renderer]', message, data)
  }

  init() {
    this.canvas = document.getElementById(this.canvasId)
    if (!this.canvas) {
      this.log('Canvas not found', { canvasId: this.canvasId })
      return
    }

    this.scene = new THREE.Scene()
    this.trackingRoot = new THREE.Group()
    this.trackingRoot.visible = false
    this.scene.add(this.trackingRoot)
    this.camera = new THREE.PerspectiveCamera(this.fov, 1, 0.01, 100)
    this.camera.position.set(0, 0, 1)
    this.camera.lookAt(0, 0, 0)

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
      precision: 'highp',
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2.5))
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.outputEncoding = THREE.sRGBEncoding
    this.renderer.sortObjects = false

    this.setupLighting()
    this.createDebugObjects()

    const profile = window.ModelTransformHelpers.getProfile()
    this.loadModel(profile.assetUrl)
    this.resize()
    this.clearCanvas()
  }

  setupLighting() {
    const ambient = new THREE.AmbientLight(0xffffff, 0.7)
    this.scene.add(ambient)

    const mainLight = new THREE.DirectionalLight(0xffffff, 0.85)
    mainLight.position.set(0, 2, 2)
    this.scene.add(mainLight)

    const fillLight = new THREE.DirectionalLight(0xffffff, 0.35)
    fillLight.position.set(0, -1, -1)
    this.scene.add(fillLight)

    const sideLight = new THREE.DirectionalLight(0xffffff, 0.25)
    sideLight.position.set(2, 1, 0)
    this.scene.add(sideLight)
  }

  createDebugObjects() {
    const planeGeo = new THREE.PlaneGeometry(1, 1)
    const planeMat = new THREE.MeshBasicMaterial({
      color: 0x00ff66,
      wireframe: true,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.35,
    })
    this.debugObjects.targetPlane = new THREE.Mesh(planeGeo, planeMat)
    this.debugObjects.targetPlane.visible = false
    this.scene.add(this.debugObjects.targetPlane)

    this.debugObjects.axes = new THREE.AxesHelper(0.25)
    this.debugObjects.axes.visible = false
    this.scene.add(this.debugObjects.axes)

    const sphereGeo = new THREE.SphereGeometry(0.02, 16, 16)
    const sphereMat = new THREE.MeshBasicMaterial({ color: 0xff3333 })
    this.debugObjects.originMarker = new THREE.Mesh(sphereGeo, sphereMat)
    this.debugObjects.originMarker.visible = false
    this.scene.add(this.debugObjects.originMarker)
  }

  loadModel(url) {
    const loader = new THREE.GLTFLoader()
    loader.load(
      url,
      (gltf) => {
        const profile = window.ModelTransformHelpers.getProfile()
        const rig = window.ModelTransformHelpers.buildModelRig(gltf.scene, profile)
        this.modelRoot = rig.root
        this.modelRoot.visible = false
        this.modelMetadata = rig.metadata
        this.trackingRoot.add(this.modelRoot)
        this.modelLoaded = true
        this.resolveModelReady()
        this.clearCanvas()

        this.log('Model loaded', {
          scaleFactor: rig.metadata.scaleFactor.toFixed(4),
          maxDim: rig.metadata.maxDim.toFixed(4),
        })
      },
      undefined,
      (error) => {
        this.log('Model load error', { message: error.message || String(error) })
      }
    )
  }

  resolveModelReady() {
    if (!this.modelLoaded) {
      return
    }

    while (this.modelReadyResolvers.length) {
      const resolve = this.modelReadyResolvers.shift()
      if (resolve) {
        resolve(this.modelRoot)
      }
    }
  }

  waitForModel(timeoutMs = 15000) {
    if (this.modelLoaded && this.modelRoot) {
      return Promise.resolve(this.modelRoot)
    }

    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        const resolverIndex = this.modelReadyResolvers.indexOf(resolver)
        if (resolverIndex >= 0) {
          this.modelReadyResolvers.splice(resolverIndex, 1)
        }
        reject(new Error('Model load timed out'))
      }, timeoutMs)

      const resolver = (modelRoot) => {
        window.clearTimeout(timeoutId)
        resolve(modelRoot)
      }

      this.modelReadyResolvers.push(resolver)
    })
  }

  getSceneContext() {
    return {
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      trackingRoot: this.trackingRoot,
      modelRoot: this.modelRoot,
    }
  }

  setXRSessionActive(active) {
    this.xrSessionActive = Boolean(active)
    if (this.renderer && this.renderer.xr) {
      this.renderer.xr.enabled = this.xrSessionActive
    }
    if (!this.xrSessionActive) {
      this.worldTrackingState = 'IDLE'
      this.worldPlacementActive = false
      if (!this.hasVisionPose) {
        this.hide()
      }
    }
  }

  setWorldTrackingState(state) {
    this.worldTrackingState = state || 'IDLE'
    if (this.xrSessionActive && !this.worldPlacementActive) {
      this.renderStats.lastPoseSource = 'WEBXR_SURFACE'
    }
  }

  setWorldPlacementFromMatrix(matrixInput, debugMeta = {}) {
    if (!this.trackingRoot) {
      return
    }

    const matrix = new THREE.Matrix4()
    if (Array.isArray(matrixInput)) {
      matrix.fromArray(matrixInput)
    } else if (matrixInput && matrixInput.elements) {
      matrix.copy(matrixInput)
    } else {
      return
    }

    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    matrix.decompose(position, quaternion, scale)

    const movementMm = this.worldPlacementActive
      ? this.trackingRoot.position.distanceTo(position) * 1000
      : 0

    this.trackingRoot.position.copy(position)
    this.trackingRoot.quaternion.copy(quaternion)
    this.trackingRoot.scale.set(1, 1, 1)
    this.worldPlacementActive = true
    this.worldTrackingState = 'TRACKING'
    this.renderStats.lastPoseSource = debugMeta.poseSource || 'WEBXR_WORLD'
    this.renderStats.lastRejectedReason = 'NONE'
    this.renderStats.poseAgeMs = 0
    this.renderStats.lastConfidence = Number((debugMeta.confidence || this.renderStats.lastConfidence || 0).toFixed(3))
    this.renderStats.translationJumpM = Number((debugMeta.translationResidualM || movementMm / 1000 || 0).toFixed(3))
    this.renderStats.rotationJumpDeg = Number((debugMeta.rotationResidualDeg || 0).toFixed(2))
    this.renderStats.renderJitterMm = Number(
      THREE.MathUtils.lerp(this.renderStats.renderJitterMm, movementMm, this.worldPlacementActive ? 0.25 : 1).toFixed(2)
    )
    this.show()
  }

  clearWorldPlacement() {
    if (!this.trackingRoot) {
      return
    }

    this.trackingRoot.position.set(0, 0, 0)
    this.trackingRoot.quaternion.identity()
    this.trackingRoot.scale.set(1, 1, 1)
    this.worldPlacementActive = false
    if (this.xrSessionActive) {
      this.worldTrackingState = 'PLACEMENT'
      this.trackingRoot.visible = false
      if (this.modelRoot) {
        this.modelRoot.visible = false
      }
    } else {
      this.worldTrackingState = 'IDLE'
      this.renderStats.renderJitterMm = 0
      this.hide()
    }
  }

  markWorldFrame(deltaMs) {
    this.renderStats.lastFrameMs = Number(deltaMs.toFixed(2))
    this.renderStats.poseAgeMs = 0
    this.renderStats.predictionActive = false
    this.renderStats.lastPoseSource = this.worldPlacementActive ? 'WEBXR_WORLD' : 'WEBXR_SURFACE'
  }

  setIntrinsics(intrinsics) {
    if (!intrinsics) {
      return
    }

    const nextFingerprint = intrinsics.fingerprint || null
    const canUpdateFov =
      !this.fovLocked ||
      (nextFingerprint && nextFingerprint !== this.intrinsicsFingerprint)

    if (
      canUpdateFov &&
      intrinsics.fovVertical &&
      intrinsics.fovVertical > 20 &&
      intrinsics.fovVertical < 120
    ) {
      this.fov = intrinsics.fovVertical
      this.camera.fov = this.fov
      this.fovLocked = true
      this.intrinsicsFingerprint = nextFingerprint
    }

    this.camera.updateProjectionMatrix()
  }

  resize(width, height, viewport) {
    if (!this.renderer || !this.canvas) {
      return
    }

    if (!width || !height) {
      const rect = this.canvas.parentElement && this.canvas.parentElement.getBoundingClientRect()
      width = (rect && rect.width) || window.innerWidth
      height = (rect && rect.height) || window.innerHeight
    }

    this.renderer.setSize(width, height, false)
    this.canvas.style.width = width + 'px'
    this.canvas.style.height = height + 'px'

    const sourceWidth = viewport && viewport.sourceWidth
    const sourceHeight = viewport && viewport.sourceHeight
    const fitMode = (viewport && viewport.fitMode) || 'cover'

    if (sourceWidth && sourceHeight && fitMode === 'cover') {
      const scale = Math.max(width / sourceWidth, height / sourceHeight)
      const visibleWidth = width / scale
      const visibleHeight = height / scale
      const offsetX = (sourceWidth - visibleWidth) / 2
      const offsetY = (sourceHeight - visibleHeight) / 2

      this.camera.aspect = sourceWidth / sourceHeight
      this.camera.setViewOffset(
        sourceWidth,
        sourceHeight,
        offsetX,
        offsetY,
        visibleWidth,
        visibleHeight
      )
    } else {
      this.camera.clearViewOffset()
      this.camera.aspect = width / height
    }

    this.camera.updateProjectionMatrix()
  }

  updatePose(result) {
    const pose = result && result.pose
    if (!pose || !pose.matrix) {
      return false
    }

    const matrixValues = pose.matrix
    if (
      !Array.isArray(matrixValues) ||
      matrixValues.length !== 16 ||
      matrixValues.some((value) => !isFinite(value))
    ) {
      return false
    }

    const matrix = new THREE.Matrix4()
    matrix.fromArray(matrixValues)

    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    matrix.decompose(position, quaternion, scale)

    const distance = position.length()
    if (distance > 12 || distance < 0.05) {
      this.renderStats.lastRejectedReason = 'distance-out-of-range'
      this.renderStats.rejectedVisionUpdates += 1
      return false
    }

    const confidence =
      typeof pose.confidence === 'number'
        ? pose.confidence
        : typeof result.debug?.tracking_confidence === 'number'
          ? result.debug.tracking_confidence
          : typeof result.debug?.confidence === 'number'
            ? result.debug.confidence
            : 0.5
    const inliers = Number(result.debug?.inliers || pose.inlier_count || 0)
    const reproj = Number(result.debug?.last_reproj_error || pose.reproj_error || 0)
    const poseSource = result.debug?.pose_source || 'VISION'
    const poseQuality = this.computePoseQuality(confidence, inliers, reproj)
    const now = performance.now()
    const poseAge = this.hasVisionPose ? now - this.lastVisionTime : Number.POSITIVE_INFINITY
    const requiresSnap =
      !this.hasVisionPose ||
      poseAge > this.reacquireSnapMs ||
      result.debug?.relocalized ||
      poseSource === 'TARGET_BOOTSTRAP' ||
      poseSource === 'RELOCALIZATION'

    if (!requiresSnap && !this.isPoseAcceptable(position, quaternion, poseQuality, poseSource)) {
      return false
    }

    if (this.hasVisionPose) {
      const dtSeconds = Math.max(1 / 120, Math.min(0.25, (now - this.lastVisionTime) / 1000))
      const measuredVelocity = position.clone().sub(this.currentVisionPosition).multiplyScalar(1 / dtSeconds)
      if (measuredVelocity.length() > 2.5) {
        measuredVelocity.setLength(2.5)
      }
      this.visionVelocity.lerp(measuredVelocity, requiresSnap ? 0.18 : 0.35)
    } else {
      this.visionVelocity.set(0, 0, 0)
    }

    if (requiresSnap) {
      this.currentVisionPosition.copy(position)
      this.currentVisionQuaternion.copy(quaternion)
      this.renderedPosition.copy(position)
      this.renderedQuaternion.copy(quaternion)
      this.previousRenderedPosition.copy(position)
      this.visionVelocity.multiplyScalar(0.3)
    } else {
      const positionBlend = THREE.MathUtils.clamp(0.42 + poseQuality * 0.35, 0.42, 0.82)
      const rotationBlend = THREE.MathUtils.clamp(0.5 + poseQuality * 0.35, 0.5, 0.88)
      this.currentVisionPosition.lerp(position, positionBlend)
      this.currentVisionQuaternion.slerp(quaternion, rotationBlend)
    }

    const frameId = result.id || pose.id
    this.visionIMUQuaternion = this.consumeIMUBaseline(frameId) || this.getCurrentIMUQuaternion()

    this.camera.position.copy(this.renderedPosition)
    this.camera.quaternion.copy(this.renderedQuaternion)

    this.renderStats.poseQuality = Number(poseQuality.toFixed(3))
    this.renderStats.translationJumpM = Number(this.currentVisionPosition.distanceTo(position).toFixed(3))
    this.renderStats.rotationJumpDeg = Number(
      THREE.MathUtils.radToDeg(this.currentVisionQuaternion.angleTo(quaternion)).toFixed(1)
    )
    this.renderStats.lastConfidence = Number(confidence.toFixed(3))
    this.renderStats.lastPoseSource = poseSource
    this.renderStats.lastRejectedReason = 'NONE'
    this.renderStats.acceptedVisionUpdates += 1
    this.renderStats.visionVelocity = Number(this.visionVelocity.length().toFixed(3))

    this.hasVisionPose = true
    this.isTracking = true
    this.lastVisionTime = now
    this.lastGapTime = 0
    this.show()

    if (this.imuManager) {
      this.imuManager.resetInertialState()
    }

    return true
  }

  computePoseQuality(confidence, inliers, reproj) {
    const inlierScore = Math.min(1, inliers / 18)
    const reprojScore = reproj > 0 ? Math.max(0, 1 - reproj / 8) : 0.6
    return THREE.MathUtils.clamp(confidence * 0.5 + inlierScore * 0.3 + reprojScore * 0.2, 0, 1)
  }

  isPoseAcceptable(position, quaternion, poseQuality, poseSource) {
    if (!this.hasVisionPose) {
      return true
    }

    const translationJump = this.currentVisionPosition.distanceTo(position)
    const rotationJumpDeg = THREE.MathUtils.radToDeg(this.currentVisionQuaternion.angleTo(quaternion))
    const isRecovery = poseSource === 'RELOCALIZATION'

    let maxTranslation = 0.1
    let maxRotation = 10
    if (poseQuality >= 0.65) {
      maxTranslation = 0.18
      maxRotation = 18
    }
    if (poseQuality >= 0.85) {
      maxTranslation = 0.28
      maxRotation = 30
    }
    if (isRecovery) {
      maxTranslation = 0.45
      maxRotation = 55
    }

    this.renderStats.translationJumpM = Number(translationJump.toFixed(3))
    this.renderStats.rotationJumpDeg = Number(rotationJumpDeg.toFixed(1))

    if (translationJump > maxTranslation) {
      this.renderStats.lastRejectedReason = 'translation-jump'
      this.renderStats.rejectedVisionUpdates += 1
      return false
    }

    if (rotationJumpDeg > maxRotation) {
      this.renderStats.lastRejectedReason = 'rotation-jump'
      this.renderStats.rejectedVisionUpdates += 1
      return false
    }

    return true
  }

  handleVisionGap(debug = {}) {
    if (!this.hasVisionPose) {
      this.hide()
      return
    }
    this.lastGapTime = performance.now()
    this.renderStats.lastRejectedReason = debug.rejected_reason || 'vision-gap'
  }

  setIMUManager(imuManager) {
    this.imuManager = imuManager
  }

  saveIMUBaseline(id, quat) {
    if (!id || !quat) {
      return
    }

    this.imuHistory.set(id, { ...quat })
    while (this.imuHistory.size > 120) {
      const firstKey = this.imuHistory.keys().next().value
      this.imuHistory.delete(firstKey)
    }
  }

  consumeIMUBaseline(id) {
    if (!id || !this.imuHistory.has(id)) {
      return null
    }

    const history = this.imuHistory.get(id)
    for (const key of this.imuHistory.keys()) {
      if (key <= id) {
        this.imuHistory.delete(key)
      }
    }

    return new THREE.Quaternion(history.x, history.y, history.z, history.w)
  }

  getCurrentIMUQuaternion() {
    if (!this.imuManager || !this.imuManager.isActive) {
      return null
    }

    const quat = this.imuManager.getTrackingQuaternion()
    return new THREE.Quaternion(quat.x, quat.y, quat.z, quat.w)
  }

  predictPose(elapsedMs) {
    const predictedPosition = this.currentVisionPosition.clone()
    const predictedQuaternion = this.currentVisionQuaternion.clone()

    if (this.visionIMUQuaternion) {
      const currentIMU = this.getCurrentIMUQuaternion()
      if (currentIMU) {
        const delta = this.visionIMUQuaternion.clone().invert().multiply(currentIMU)
        predictedQuaternion.multiply(delta)
      }
    }

    if (elapsedMs < this.translationPredictionWindowMs && this.visionVelocity.lengthSq() > 0.000001) {
      const dt = elapsedMs / 1000
      const translationDelta = this.visionVelocity.clone().multiplyScalar(dt * 0.55)
      if (translationDelta.length() > 0.06) {
        translationDelta.setLength(0.06)
      }
      predictedPosition.add(translationDelta)
    }

    return {
      position: predictedPosition,
      quaternion: predictedQuaternion,
    }
  }

  computeDampingAlpha(deltaSeconds, frequencyHz) {
    return 1 - Math.exp(-frequencyHz * deltaSeconds)
  }

  hasTracking() {
    return (this.isTracking && this.hasVisionPose) || this.worldPlacementActive
  }

  getRenderState() {
    if (this.xrSessionActive) {
      return this.worldPlacementActive ? 'WORLD_TRACKING' : 'WORLD_SEARCHING'
    }

    if (!this.hasVisionPose) {
      return 'SEARCHING'
    }

    const sinceVision = performance.now() - this.lastVisionTime
    if (sinceVision < 90) {
      return 'TRACKING'
    }
    if (sinceVision < this.predictionMaxMs) {
      return 'PREDICTING'
    }
    return 'SEARCHING'
  }

  getPoseSnapshot() {
    if (!this.hasTracking()) {
      return null
    }

    const sourcePosition = this.worldPlacementActive && this.trackingRoot
      ? this.trackingRoot.position
      : this.renderedPosition

    return {
      position: {
        x: sourcePosition.x,
        y: sourcePosition.y,
        z: sourcePosition.z,
      },
      poseAgeMs: this.renderStats.poseAgeMs,
    }
  }

  getDiagnostics() {
    return {
      ...this.renderStats,
      renderState: this.getRenderState(),
      fov: Number(this.fov.toFixed(2)),
      xrSessionActive: this.xrSessionActive,
      worldTrackingState: this.worldTrackingState,
      worldPlacementActive: this.worldPlacementActive,
    }
  }

  clearCanvas() {
    if (!this.renderer || !this.scene || !this.camera) {
      return
    }

    this.renderer.clear()
    this.renderer.render(this.scene, this.camera)
  }

  expireTracking() {
    this.isTracking = false
    this.hasVisionPose = false
    this.visionIMUQuaternion = null
    this.visionVelocity.set(0, 0, 0)
    this.hide()
  }

  resetPose() {
    this.currentVisionPosition.set(0, 0, 0)
    this.currentVisionQuaternion.identity()
    this.renderedPosition.set(0, 0, 0)
    this.renderedQuaternion.identity()
    this.previousRenderedPosition.set(0, 0, 0)
    this.visionVelocity.set(0, 0, 0)
    this.imuHistory.clear()
    this.visionIMUQuaternion = null
    this.hasVisionPose = false
    this.isTracking = false
    this.worldPlacementActive = false
    this.worldTrackingState = this.xrSessionActive ? 'PLACEMENT' : 'IDLE'
    this.renderStats.poseQuality = 0
    this.renderStats.poseAgeMs = 0
    this.renderStats.predictionActive = false
    this.renderStats.renderJitterMm = 0
    this.renderStats.lastRejectedReason = 'NONE'
    this.hide()
  }

  updateDebugVisibility() {
    const debugVisible = this.debugMode && this.hasTracking()
    this.debugObjects.targetPlane.visible = debugVisible
    this.debugObjects.axes.visible = debugVisible
    this.debugObjects.originMarker.visible = debugVisible
  }

  show() {
    if (this.trackingRoot) {
      this.trackingRoot.visible = true
    }
    if (this.modelRoot) {
      this.modelRoot.visible = true
    }
    this.updateDebugVisibility()
  }

  hide() {
    if (this.modelRoot) {
      this.modelRoot.visible = false
    }
    if (this.trackingRoot) {
      this.trackingRoot.visible = false
    }
    this.debugObjects.targetPlane.visible = false
    this.debugObjects.axes.visible = false
    this.debugObjects.originMarker.visible = false
    if (!this.xrSessionActive) {
      this.clearCanvas()
    }
  }

  render() {
    if (!this.renderer || !this.scene || !this.camera) {
      return
    }

    const now = performance.now()
    const deltaSeconds = Math.min(0.05, Math.max(1 / 120, (now - this.lastRenderTime) / 1000))
    this.lastRenderTime = now
    this.renderStats.lastFrameMs = Number((deltaSeconds * 1000).toFixed(2))

    if (this.hasVisionPose) {
      const elapsedMs = now - this.lastVisionTime
      this.renderStats.poseAgeMs = Math.round(elapsedMs)
      if (elapsedMs > this.predictionMaxMs) {
        this.expireTracking()
      } else {
        const predicted = this.predictPose(elapsedMs)
        const positionHz = elapsedMs > 85 ? 10 : 16 + this.renderStats.poseQuality * 8
        const rotationHz = elapsedMs > 85 ? 12 : 18 + this.renderStats.poseQuality * 10
        const positionAlpha = this.computeDampingAlpha(deltaSeconds, positionHz)
        const rotationAlpha = this.computeDampingAlpha(deltaSeconds, rotationHz)

        this.renderedPosition.lerp(predicted.position, positionAlpha)
        this.renderedQuaternion.slerp(predicted.quaternion, rotationAlpha)
        this.camera.position.copy(this.renderedPosition)
        this.camera.quaternion.copy(this.renderedQuaternion)
        this.renderStats.predictionActive = elapsedMs >= 90

        const jitterMm = this.previousRenderedPosition.distanceTo(this.renderedPosition) * 1000
        this.renderStats.renderJitterMm = Number(
          THREE.MathUtils.lerp(this.renderStats.renderJitterMm, jitterMm, 0.2).toFixed(2)
        )
        this.previousRenderedPosition.copy(this.renderedPosition)
        this.updateDebugVisibility()
      }
    } else {
      this.renderStats.poseAgeMs = 0
      this.renderStats.predictionActive = false
    }

    this.renderer.render(this.scene, this.camera)
  }

  setDebug(enabled) {
    this.debugMode = enabled
    this.updateDebugVisibility()
  }

  getFOV() {
    return this.fov
  }
}

window.ModelRenderer = ModelRenderer





















