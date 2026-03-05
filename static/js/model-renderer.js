/**
 * Three.js model renderer for hybrid vision + IMU tracking.
 *
 * Vision frames provide world-space correction from the backend.
 * Device motion provides immediate rotation updates between backend results.
 */

class ModelRenderer {
  constructor(canvasId) {
    this.canvasId = canvasId || 'threeCanvas'
    this.canvas = null
    this.scene = null
    this.camera = null
    this.renderer = null

    this.modelRoot = null
    this.modelLoaded = false
    this.modelMetadata = null

    this.fov = 60
    this.fovLocked = false
    this.intrinsicsFingerprint = null

    this.imuManager = null
    this.imuHistory = new Map()

    this.currentVisionPosition = new THREE.Vector3()
    this.currentVisionQuaternion = new THREE.Quaternion()
    this.renderedPosition = new THREE.Vector3()
    this.renderedQuaternion = new THREE.Quaternion()
    this.visionIMUQuaternion = null

    this.hasVisionPose = false
    this.isTracking = false
    this.lastVisionTime = 0
    this.lastGapTime = 0
    this.predictionMaxMs = 450
    this.translationPredictionWindowMs = 120
    this.translationPredictionEnabled = true

    this.debugMode = true
    this.debugObjects = {}

    this.init()
  }

  init() {
    this.canvas = document.getElementById(this.canvasId)
    if (!this.canvas) {
      console.error('[Renderer] Canvas not found:', this.canvasId)
      return
    }

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(this.fov, 1, 0.01, 100)
    this.camera.position.set(0, 0, 1)
    this.camera.lookAt(0, 0, 0)

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.outputEncoding = THREE.sRGBEncoding

    this.setupLighting()
    this.createDebugObjects()

    const profile = window.ModelTransformHelpers.getProfile()
    this.loadModel(profile.assetUrl)
    this.resize()
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
      opacity: 0.4,
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
        this.scene.add(this.modelRoot)
        this.modelLoaded = true

        console.log('[Renderer] Model loaded:', {
          scaleFactor: rig.metadata.scaleFactor.toFixed(4),
          maxDim: rig.metadata.maxDim.toFixed(4),
        })
      },
      undefined,
      (error) => {
        console.error('[Renderer] Model load error:', error)
      }
    )
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
      return
    }

    const matrixValues = pose.matrix
    if (
      !Array.isArray(matrixValues) ||
      matrixValues.length !== 16 ||
      matrixValues.some((value) => !isFinite(value))
    ) {
      return
    }

    const matrix = new THREE.Matrix4()
    matrix.fromArray(matrixValues)

    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    matrix.decompose(position, quaternion, scale)

    const distance = position.length()
    if (distance > 10 || distance < 0.05) {
      return
    }

    const confidence =
      typeof pose.confidence === 'number'
        ? pose.confidence
        : typeof result.debug?.tracking_confidence === 'number'
          ? result.debug.tracking_confidence
          : typeof result.debug?.confidence === 'number'
            ? result.debug.confidence
            : 0.5

    if (!this.hasVisionPose) {
      this.currentVisionPosition.copy(position)
      this.currentVisionQuaternion.copy(quaternion)
      this.renderedPosition.copy(position)
      this.renderedQuaternion.copy(quaternion)
      this.camera.position.copy(position)
      this.camera.quaternion.copy(quaternion)
    } else {
      const positionError = this.currentVisionPosition.distanceTo(position)
      const rotationError = this.currentVisionQuaternion.angleTo(quaternion)
      const shouldSnap =
        confidence >= 0.7 || positionError > 0.08 || rotationError > THREE.MathUtils.degToRad(10)

      if (shouldSnap) {
        this.currentVisionPosition.copy(position)
        this.currentVisionQuaternion.copy(quaternion)
      } else {
        const positionBlend = Math.max(0.78, confidence)
        const rotationBlend = Math.max(0.85, confidence)
        this.currentVisionPosition.lerp(position, positionBlend)
        this.currentVisionQuaternion.slerp(quaternion, rotationBlend)
      }
    }

    const frameId = result.id || pose.id
    this.visionIMUQuaternion = this.consumeIMUBaseline(frameId) || this.getCurrentIMUQuaternion()
    this.renderedPosition.copy(this.currentVisionPosition)
    this.renderedQuaternion.copy(this.currentVisionQuaternion)
    this.camera.position.copy(this.renderedPosition)
    this.camera.quaternion.copy(this.renderedQuaternion)

    this.hasVisionPose = true
    this.isTracking = true
    this.lastVisionTime = performance.now()
    this.lastGapTime = 0
    this.show()

    if (this.imuManager) {
      this.imuManager.resetInertialState()
    }
  }

  handleVisionGap() {
    if (!this.hasVisionPose) {
      this.hide()
      return
    }
    this.lastGapTime = performance.now()
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

    if (
      this.translationPredictionEnabled &&
      this.imuManager &&
      this.imuManager.linVel &&
      elapsedMs < this.translationPredictionWindowMs &&
      this.imuManager.linVel.length() > 0.02
    ) {
      const velocityWorld = this.imuManager.linVel.clone().applyQuaternion(predictedQuaternion)
      const dt = elapsedMs / 1000
      const translationDelta = velocityWorld.multiplyScalar(dt * 0.15)
      if (translationDelta.length() > 0.08) {
        translationDelta.setLength(0.08)
      }
      predictedPosition.add(translationDelta)
    }

    this.renderedPosition.copy(predictedPosition)
    this.renderedQuaternion.copy(predictedQuaternion)
    return {
      position: predictedPosition,
      quaternion: predictedQuaternion,
    }
  }

  hasTracking() {
    return this.isTracking && this.hasVisionPose
  }

  getRenderState() {
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

    return {
      position: {
        x: this.renderedPosition.x,
        y: this.renderedPosition.y,
        z: this.renderedPosition.z,
      },
    }
  }

  expireTracking() {
    this.isTracking = false
    this.hasVisionPose = false
    this.visionIMUQuaternion = null
    this.hide()
  }

  resetPose() {
    this.currentVisionPosition.set(0, 0, 0)
    this.currentVisionQuaternion.identity()
    this.renderedPosition.set(0, 0, 0)
    this.renderedQuaternion.identity()
    this.imuHistory.clear()
    this.visionIMUQuaternion = null
    this.hasVisionPose = false
    this.isTracking = false
    this.hide()
  }

  show() {
    if (this.modelRoot) {
      this.modelRoot.visible = true
    }
    if (this.debugMode) {
      this.debugObjects.targetPlane.visible = true
      this.debugObjects.axes.visible = true
      this.debugObjects.originMarker.visible = true
    }
  }

  hide() {
    if (this.modelRoot) {
      this.modelRoot.visible = false
    }
    this.debugObjects.targetPlane.visible = false
    this.debugObjects.axes.visible = false
    this.debugObjects.originMarker.visible = false
  }

  render() {
    if (!this.renderer || !this.scene || !this.camera) {
      return
    }

    if (this.hasVisionPose) {
      const elapsedMs = performance.now() - this.lastVisionTime
      if (elapsedMs > this.predictionMaxMs) {
        this.expireTracking()
      } else {
        const predicted = this.predictPose(elapsedMs)
        this.camera.position.copy(predicted.position)
        this.camera.quaternion.copy(predicted.quaternion)
        this.show()
      }
    }

    this.renderer.render(this.scene, this.camera)
  }

  setDebug(enabled) {
    this.debugMode = enabled
    if (!enabled) {
      this.hide()
      if (this.modelRoot) {
        this.modelRoot.visible = this.hasTracking()
      }
    }
  }

  getFOV() {
    return this.fov
  }
}

window.ModelRenderer = ModelRenderer
