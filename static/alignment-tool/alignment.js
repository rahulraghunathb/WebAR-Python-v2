/**
 * Alignment tool that uses the same model rig as the runtime renderer.
 */

class AlignmentTool {
  constructor() {
    this.profile = window.ModelTransformHelpers.getProfile()
    this.targetImagePath = this.profile.targetImageUrl
    this.modelPath = this.profile.assetUrl

    this.targetWidth = 1.0
    this.targetHeight = 1.0

    this.scene = null
    this.camera = null
    this.renderer = null
    this.controls = null
    this.modelRoot = null
    this.alignmentGroup = null
    this.targetPlane = null
    this.modelLoaded = false

    this.transform = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      uniformScale: 1,
    }

    this.init()
  }

  init() {
    this.initThreeJS()
    this.loadTargetImage()
    this.loadModel()
    this.setupControls()
    this.setupEventListeners()
    this.updateOutput()
    this.animate()
  }

  initThreeJS() {
    const canvas = document.getElementById('alignmentCanvas')
    const container = canvas.parentElement

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x1a1a2e)

    const aspect = container.clientWidth / container.clientHeight
    this.camera = new THREE.PerspectiveCamera(50, aspect, 0.01, 100)
    this.camera.position.set(0, 0.5, 2)
    this.camera.lookAt(0, 0, 0)

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(container.clientWidth, container.clientHeight)
    this.renderer.outputEncoding = THREE.sRGBEncoding

    const ambient = new THREE.AmbientLight(0xffffff, 0.65)
    this.scene.add(ambient)

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8)
    dirLight.position.set(5, 10, 7)
    this.scene.add(dirLight)

    const backLight = new THREE.DirectionalLight(0xffffff, 0.3)
    backLight.position.set(-5, 5, -5)
    this.scene.add(backLight)

    this.controls = new THREE.OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.05
    this.controls.target.set(0, 0, 0)

    const gridHelper = new THREE.GridHelper(2, 20, 0x444444, 0x333333)
    gridHelper.position.y = -0.01
    this.scene.add(gridHelper)

    this.scene.add(new THREE.AxesHelper(0.3))

    window.addEventListener('resize', () => this.onResize())
  }

  loadTargetImage() {
    const textureLoader = new THREE.TextureLoader()
    textureLoader.load(
      this.targetImagePath,
      (texture) => {
        texture.encoding = THREE.sRGBEncoding
        const imageAspect = texture.image.width / texture.image.height
        this.targetHeight = this.targetWidth / imageAspect

        const geometry = new THREE.PlaneGeometry(this.targetWidth, this.targetHeight)
        const material = new THREE.MeshBasicMaterial({
          map: texture,
          side: THREE.DoubleSide,
        })

        this.targetPlane = new THREE.Mesh(geometry, material)
        this.scene.add(this.targetPlane)

        const borderGeometry = new THREE.EdgesGeometry(geometry)
        const borderMaterial = new THREE.LineBasicMaterial({ color: 0x00c870 })
        this.targetPlane.add(new THREE.LineSegments(borderGeometry, borderMaterial))
      },
      undefined,
      (error) => console.error('[Alignment] Failed to load target image:', error)
    )
  }

  loadModel() {
    const loader = new THREE.GLTFLoader()
    loader.load(
      this.modelPath,
      (gltf) => {
        const rig = window.ModelTransformHelpers.buildModelRig(gltf.scene, this.profile)
        this.modelRoot = rig.root
        this.alignmentGroup = rig.alignmentGroup
        this.scene.add(this.modelRoot)
        this.modelLoaded = true
        this.applyTransform()
        this.updateOutput()
      },
      undefined,
      (error) => console.error('[Alignment] Failed to load model:', error)
    )
  }

  setupControls() {
    this.bindSliderPair('posX', 'posXNum', (value) => {
      this.transform.position.x = value
      this.applyTransform()
    })
    this.bindSliderPair('posY', 'posYNum', (value) => {
      this.transform.position.y = value
      this.applyTransform()
    })
    this.bindSliderPair('posZ', 'posZNum', (value) => {
      this.transform.position.z = value
      this.applyTransform()
    })

    this.bindSliderPair('rotX', 'rotXNum', (value) => {
      this.transform.rotation.x = value
      this.applyTransform()
    })
    this.bindSliderPair('rotY', 'rotYNum', (value) => {
      this.transform.rotation.y = value
      this.applyTransform()
    })
    this.bindSliderPair('rotZ', 'rotZNum', (value) => {
      this.transform.rotation.z = value
      this.applyTransform()
    })

    this.bindSliderPair('scaleUniform', 'scaleUniformNum', (value) => {
      this.transform.uniformScale = value
      if (!document.getElementById('nonUniformScale').checked) {
        this.transform.scale = { x: value, y: value, z: value }
      }
      this.applyTransform()
    })

    this.bindSliderPair('scaleX', 'scaleXNum', (value) => {
      this.transform.scale.x = value
      this.applyTransform()
    })
    this.bindSliderPair('scaleY', 'scaleYNum', (value) => {
      this.transform.scale.y = value
      this.applyTransform()
    })
    this.bindSliderPair('scaleZ', 'scaleZNum', (value) => {
      this.transform.scale.z = value
      this.applyTransform()
    })

    document.getElementById('nonUniformScale').addEventListener('change', (event) => {
      const controls = document.getElementById('nonUniformControls')
      controls.classList.toggle('hidden', !event.target.checked)
      if (!event.target.checked) {
        const uniform = this.transform.uniformScale
        this.transform.scale = { x: uniform, y: uniform, z: uniform }
        this.updateSliderPair('scaleX', 'scaleXNum', uniform)
        this.updateSliderPair('scaleY', 'scaleYNum', uniform)
        this.updateSliderPair('scaleZ', 'scaleZNum', uniform)
        this.applyTransform()
      }
    })
  }

  bindSliderPair(sliderId, numberId, onChange) {
    const slider = document.getElementById(sliderId)
    const number = document.getElementById(numberId)

    slider.addEventListener('input', () => {
      const value = parseFloat(slider.value)
      number.value = value
      onChange(value)
      this.updateOutput()
    })

    number.addEventListener('input', () => {
      const value = parseFloat(number.value) || 0
      slider.value = value
      onChange(value)
      this.updateOutput()
    })
  }

  updateSliderPair(sliderId, numberId, value) {
    document.getElementById(sliderId).value = value
    document.getElementById(numberId).value = value
  }

  setupEventListeners() {
    document.getElementById('resetBtn').addEventListener('click', () => this.resetTransform())

    document.getElementById('centerBtn').addEventListener('click', () => {
      this.transform.position = { x: 0, y: 0, z: 0 }
      this.updateSliderPair('posX', 'posXNum', 0)
      this.updateSliderPair('posY', 'posYNum', 0)
      this.updateSliderPair('posZ', 'posZNum', 0)
      this.applyTransform()
      this.updateOutput()
    })

    document.getElementById('flipXBtn').addEventListener('click', () => {
      this.transform.scale.x *= -1
      this.updateSliderPair('scaleX', 'scaleXNum', this.transform.scale.x)
      this.applyTransform()
      this.updateOutput()
    })

    document.getElementById('flipYBtn').addEventListener('click', () => {
      this.transform.scale.y *= -1
      this.updateSliderPair('scaleY', 'scaleYNum', this.transform.scale.y)
      this.applyTransform()
      this.updateOutput()
    })

    document.getElementById('flipZBtn').addEventListener('click', () => {
      this.transform.scale.z *= -1
      this.updateSliderPair('scaleZ', 'scaleZNum', this.transform.scale.z)
      this.applyTransform()
      this.updateOutput()
    })

    document.getElementById('rotate90XBtn').addEventListener('click', () => {
      this.rotateBy('x', 90)
    })
    document.getElementById('rotate90YBtn').addEventListener('click', () => {
      this.rotateBy('y', 90)
    })
    document.getElementById('rotate90ZBtn').addEventListener('click', () => {
      this.rotateBy('z', 90)
    })

    document.getElementById('outputFormat').addEventListener('change', () => this.updateOutput())
    document.getElementById('copyBtn').addEventListener('click', () => this.copyToClipboard())
  }

  rotateBy(axis, delta) {
    this.transform.rotation[axis] = (this.transform.rotation[axis] + delta) % 360
    if (this.transform.rotation[axis] > 180) {
      this.transform.rotation[axis] -= 360
    }
    const suffix = axis.toUpperCase()
    this.updateSliderPair('rot' + suffix, 'rot' + suffix + 'Num', this.transform.rotation[axis])
    this.applyTransform()
    this.updateOutput()
  }

  resetTransform() {
    this.transform = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      uniformScale: 1,
    }

    this.updateSliderPair('posX', 'posXNum', 0)
    this.updateSliderPair('posY', 'posYNum', 0)
    this.updateSliderPair('posZ', 'posZNum', 0)
    this.updateSliderPair('rotX', 'rotXNum', 0)
    this.updateSliderPair('rotY', 'rotYNum', 0)
    this.updateSliderPair('rotZ', 'rotZNum', 0)
    this.updateSliderPair('scaleUniform', 'scaleUniformNum', 1)
    this.updateSliderPair('scaleX', 'scaleXNum', 1)
    this.updateSliderPair('scaleY', 'scaleYNum', 1)
    this.updateSliderPair('scaleZ', 'scaleZNum', 1)

    document.getElementById('nonUniformScale').checked = false
    document.getElementById('nonUniformControls').classList.add('hidden')

    this.applyTransform()
    this.updateOutput()
  }

  buildAlignmentConfig() {
    const nonUniform = document.getElementById('nonUniformScale').checked
    return {
      position: {
        x: parseFloat(this.transform.position.x.toFixed(4)),
        y: parseFloat(this.transform.position.y.toFixed(4)),
        z: parseFloat(this.transform.position.z.toFixed(4)),
      },
      rotation: {
        x: parseFloat(THREE.MathUtils.degToRad(this.transform.rotation.x).toFixed(6)),
        y: parseFloat(THREE.MathUtils.degToRad(this.transform.rotation.y).toFixed(6)),
        z: parseFloat(THREE.MathUtils.degToRad(this.transform.rotation.z).toFixed(6)),
      },
      scale: nonUniform
        ? {
            x: parseFloat(this.transform.scale.x.toFixed(4)),
            y: parseFloat(this.transform.scale.y.toFixed(4)),
            z: parseFloat(this.transform.scale.z.toFixed(4)),
          }
        : parseFloat(this.transform.uniformScale.toFixed(4)),
    }
  }

  applyTransform() {
    if (!this.alignmentGroup) {
      return
    }
    window.ModelTransformHelpers.applyAlignment(this.alignmentGroup, this.buildAlignmentConfig())
  }

  updateOutput() {
    const format = document.getElementById('outputFormat').value
    const alignment = this.buildAlignmentConfig()
    let output = ''

    if (format === 'json') {
      output = JSON.stringify(alignment, null, 2)
    } else if (format === 'js') {
      output = `window.MODEL_RUNTIME_PROFILE = {\n  ...window.MODEL_RUNTIME_PROFILE,\n  alignment: ${JSON.stringify(alignment, null, 2)}\n}`
    } else {
      const scaleCode =
        typeof alignment.scale === 'number'
          ? `alignmentGroup.scale.setScalar(${alignment.scale.toFixed(4)});`
          : `alignmentGroup.scale.set(${alignment.scale.x.toFixed(4)}, ${alignment.scale.y.toFixed(4)}, ${alignment.scale.z.toFixed(4)});`

      output = `alignmentGroup.position.set(${alignment.position.x.toFixed(4)}, ${alignment.position.y.toFixed(4)}, ${alignment.position.z.toFixed(4)});\nalignmentGroup.rotation.set(${alignment.rotation.x.toFixed(6)}, ${alignment.rotation.y.toFixed(6)}, ${alignment.rotation.z.toFixed(6)}, 'XYZ');\n${scaleCode}`
    }

    document.getElementById('outputCode').textContent = output
  }

  async copyToClipboard() {
    const output = document.getElementById('outputCode').textContent
    const copyBtn = document.getElementById('copyBtn')
    const copyText = document.getElementById('copyText')

    try {
      await navigator.clipboard.writeText(output)
      copyBtn.classList.add('copied')
      copyText.textContent = 'Copied!'
      setTimeout(() => {
        copyBtn.classList.remove('copied')
        copyText.textContent = 'Copy to Clipboard'
      }, 2000)
    } catch (error) {
      console.error('[Alignment] Copy failed:', error)
      copyText.textContent = 'Copy failed'
      setTimeout(() => {
        copyText.textContent = 'Copy to Clipboard'
      }, 2000)
    }
  }

  onResize() {
    const container = this.renderer.domElement.parentElement
    const width = container.clientWidth
    const height = container.clientHeight

    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height)
  }

  animate() {
    requestAnimationFrame(() => this.animate())
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.alignmentTool = new AlignmentTool()
})
