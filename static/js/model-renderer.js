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

}

window.ModelRenderer = ModelRenderer





















