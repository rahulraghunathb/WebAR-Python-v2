/**
 * Alignment tool that uses the same model rig as the runtime renderer.
 */

(function () {
  const NS = 'webar-alignment-tool:v1'
  const DEFAULT_ALIGNMENT = {
    position: { x: 0.01, y: 0.04, z: 0.13 },
    rotation: { x: 1.570796, y: 0, z: 0 },
    scale: 2.04,
  }
  const DEFAULT_PROFILE = {
    assetUrl: '/static/assets/ranger-3d-model.glb',
    targetImageUrl: '/static/assets/ranger-base-image.jpg',
    targetPhysicalWidthMeters: 0.2,
    baseScaleMeters: 0.22,
    uprightRotation: { x: 0, y: 0, z: 0 },
    alignment: DEFAULT_ALIGNMENT,
  }
  const copy = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)))
  const vec3 = (v, f) => {
    const s = v || f || { x: 0, y: 0, z: 0 }
    return { x: Number(s.x || 0), y: Number(s.y || 0), z: Number(s.z || 0) }
  }
  const scale = (v) =>
    typeof v === 'number'
      ? Number(v)
      : v && typeof v === 'object'
        ? { x: Number(v.x || 1), y: Number(v.y || 1), z: Number(v.z || 1) }
        : 1
  const align = (v) => ({
    position: vec3(v && v.position, DEFAULT_ALIGNMENT.position),
    rotation: vec3(v && v.rotation, DEFAULT_ALIGNMENT.rotation),
    scale: scale(v && v.scale),
  })
  const base = (v) => {
    if (!v) return ''
    const clean = String(v).split('?')[0].split('#')[0]
    const parts = clean.split(/[\\/]/)
    return parts[parts.length - 1] || clean
  }
  const slug = (v) =>
    (String(v || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'profile').replace(
      /^-+|-+$/g,
      ''
    )
  const meters = (v) => Number(v || 0).toFixed(3) + ' m'
  const alignSummary = (v) => {
    const a = align(v)
    const s =
      typeof a.scale === 'number'
        ? Number(a.scale).toFixed(3)
        : [a.scale.x, a.scale.y, a.scale.z].map((n) => Number(n || 0).toFixed(3)).join(' x ')
    return (
      'pos(' +
      [a.position.x, a.position.y, a.position.z].map((n) => Number(n || 0).toFixed(3)).join(', ') +
      ') rot(' +
      [a.rotation.x, a.rotation.y, a.rotation.z].map((n) => Number(n || 0).toFixed(3)).join(', ') +
      ') scale(' +
      s +
      ')'
    )
  }
  const isProfile = (v) =>
    Boolean(v && typeof v === 'object' && (v.assetUrl || v.targetImageUrl || v.targetPhysicalWidthMeters || v.alignment))
  const listify = (v) => {
    if (!v) return []
    if (Array.isArray(v)) return v.slice()
    if (v instanceof Map) return Array.from(v.values())
    if (typeof v !== 'object') return []
    if (isProfile(v)) return [v]
    return Object.entries(v).map(([key, item]) =>
      item && typeof item === 'object'
        ? { key, id: item.id || key, name: item.name || item.label || key, ...item }
        : { key, id: key, name: String(item || key) }
    )
  }

  class AlignmentTool {
    constructor() {
      this.helpers = window.ModelTransformHelpers || {}
      this.storageOk = this.canStore()
      this.catalog = []
      this.catalogByKey = new Map()
      this.profile = null
      this.profileKey = ''
      this.profileSource = 'catalog'
      this.profileLoading = false
      this.targetLoadToken = 0
      this.modelLoadToken = 0
      this.targetWidth = 1
      this.targetHeight = 1
      this.scene = this.camera = this.renderer = this.controls = null
      this.modelRoot = this.alignmentGroup = this.targetPlane = null
      this.modelLoaded = false
      this.transform = {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        uniformScale: 1,
      }
      this.init()
    }

    canStore() {
      try {
        const k = NS + ':probe'
        localStorage.setItem(k, '1')
        localStorage.removeItem(k)
        return true
      } catch (_) {
        return false
      }
    }
    skey(key) {
      return NS + ':profile:' + key
    }
    selectedKey() {
      return NS + ':selected-profile'
    }
    read(key) {
      if (!this.storageOk) return null
      try {
        const raw = localStorage.getItem(key)
        return raw ? JSON.parse(raw) : null
      } catch (_) {
        return null
      }
    }
    write(key, value) {
      if (!this.storageOk) return false
      try {
        localStorage.setItem(key, JSON.stringify(value))
        return true
      } catch (_) {
        return false
      }
    }
    remove(key) {
      if (!this.storageOk) return false
      try {
        localStorage.removeItem(key)
        return true
      } catch (_) {
        return false
      }
    }

    sourceCatalog() {
      const h = this.helpers || {}
      for (const name of ['getProfileCatalog', 'getProfiles', 'listProfiles', 'getCatalog', 'getTargetCatalog']) {
        if (typeof h[name] === 'function') {
          const value = h[name]()
          if (value) return value
        }
      }
      if (Array.isArray(window.MODEL_RUNTIME_PROFILES)) return window.MODEL_RUNTIME_PROFILES
      if (Array.isArray(window.MODEL_RUNTIME_TARGETS)) return window.MODEL_RUNTIME_TARGETS
      if (window.MODEL_RUNTIME_PROFILE_CATALOG) return window.MODEL_RUNTIME_PROFILE_CATALOG
      if (isProfile(window.MODEL_RUNTIME_PROFILE)) return [window.MODEL_RUNTIME_PROFILE]
      if (typeof h.getProfile === 'function') return [h.getProfile()]
      return [DEFAULT_PROFILE]
    }
    keyFor(raw, index) {
      const candidates = [
        raw && raw.key,
        raw && raw.id,
        raw && raw.slug,
        raw && raw.profileId,
        raw && raw.targetId,
        raw && raw.name,
        raw && raw.label,
        raw && raw.targetName,
        base(raw && raw.assetUrl),
        base(raw && raw.targetImageUrl),
      ]
      for (const candidate of candidates) {
        if (candidate != null && String(candidate).trim()) return slug(candidate)
      }
      return 'profile-' + (index + 1)
    }
    normalizeProfile(raw, index) {
      const src = raw && typeof raw === 'object' ? copy(raw) : {}
      const key = this.keyFor(src, index)
      const name =
        src.name || src.label || src.title || src.targetName || base(src.targetImageUrl) || base(src.assetUrl) || 'Target ' + (index + 1)
      const targetImageUrl =
        src.targetImageUrl || src.targetImage || src.referenceImageUrl || src.referenceImage || DEFAULT_PROFILE.targetImageUrl
      const assetUrl = src.assetUrl || src.modelUrl || src.modelPath || DEFAULT_PROFILE.assetUrl
      const alignment = align(src.alignment)
      return {
        ...src,
        key,
        id: src.id || key,
        name,
        label: src.label || name,
        targetName: src.targetName || name,
        assetUrl,
        targetImageUrl,
        targetPhysicalWidthMeters: Number(src.targetPhysicalWidthMeters || DEFAULT_PROFILE.targetPhysicalWidthMeters),
        baseScaleMeters: Number(src.baseScaleMeters || DEFAULT_PROFILE.baseScaleMeters),
        uprightRotation: vec3(src.uprightRotation, DEFAULT_PROFILE.uprightRotation),
        alignment,
        defaultAlignment: copy(alignment),
        thumbnailUrl: src.thumbnailUrl || src.previewUrl || src.imageUrl || targetImageUrl || '',
        storageKey: this.skey(key),
      }
    }
    buildCatalog() {
      const seen = new Set()
      return listify(this.sourceCatalog())
        .map((entry, index) => this.normalizeProfile(entry, index))
        .map((profile) => {
          let key = profile.key
          let count = 2
          while (seen.has(key)) {
            key = profile.key + '-' + count
            count += 1
          }
          seen.add(key)
          return { ...profile, key, id: profile.id || key, storageKey: this.skey(key) }
        })
    }
    qKey() {
      try {
        const params = new URLSearchParams(location.search)
        return (params.get('profile') || params.get('target') || params.get('targetId') || params.get('profileId') || '').trim()
      } catch (_) {
        return ''
      }
    }
    storedKey() {
      const saved = this.read(this.selectedKey())
      return saved && saved.key ? String(saved.key) : ''
    }
    startKey() {
      const q = this.qKey()
      if (q && this.catalogByKey.has(q)) {
        this.profileSource = 'query'
        return q
      }
      const stored = this.storedKey()
      if (stored && this.catalogByKey.has(stored)) {
        this.profileSource = 'local-storage'
        return stored
      }
      const helper = typeof this.helpers.getProfile === 'function' ? this.helpers.getProfile() : null
      if (helper) {
        const k = this.keyFor(helper, 0)
        if (this.catalogByKey.has(k)) {
          this.profileSource = 'helper'
          return k
        }
      }
      this.profileSource = 'catalog'
      return this.catalog[0] ? this.catalog[0].key : 'default'
    }
    setText(id, value) {
      const el = document.getElementById(id)
      if (el) el.textContent = value
    }
    setBadge(value) {
      this.setText('profileBadge', value)
    }
    setPreview(url) {
      const img = document.getElementById('profilePreview')
      const fallback = document.getElementById('profilePreviewFallback')
      if (!img || !fallback) return
      if (!url) {
        img.removeAttribute('src')
        fallback.style.display = 'grid'
        return
      }
      img.onload = () => (fallback.style.display = 'none')
      img.onerror = () => {
        img.removeAttribute('src')
        fallback.style.display = 'grid'
      }
      fallback.style.display = 'grid'
      img.src = url
    }

    init() {
      this.initThreeJS()
      this.setupControls()
      this.setupEvents()
      this.catalog = this.buildCatalog()
      this.catalogByKey = new Map(this.catalog.map((p) => [p.key, p]))
      this.profileKey = this.startKey()
      this.populateSelect()
      this.selectProfile(this.profileKey, { initial: true, useSaved: true })
      this.animate()
    }

    initThreeJS() {
      const canvas = document.getElementById('alignmentCanvas')
      const container = canvas.parentElement
      this.scene = new THREE.Scene()
      this.scene.background = new THREE.Color(0x1a1a2e)
      this.camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.01, 100)
      this.camera.position.set(0, 0.5, 2)
      this.camera.lookAt(0, 0, 0)
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      this.renderer.setSize(container.clientWidth, container.clientHeight)
      this.renderer.outputEncoding = THREE.sRGBEncoding
      this.scene.add(new THREE.AmbientLight(0xffffff, 0.65))
      const main = new THREE.DirectionalLight(0xffffff, 0.8)
      main.position.set(5, 10, 7)
      this.scene.add(main)
      const back = new THREE.DirectionalLight(0xffffff, 0.3)
      back.position.set(-5, 5, -5)
      this.scene.add(back)
      this.controls = new THREE.OrbitControls(this.camera, canvas)
      this.controls.enableDamping = true
      this.controls.dampingFactor = 0.05
      this.controls.target.set(0, 0, 0)
      const grid = new THREE.GridHelper(2, 20, 0x444444, 0x333333)
      grid.position.y = -0.01
      this.scene.add(grid)
      this.scene.add(new THREE.AxesHelper(0.3))
      window.addEventListener('resize', () => this.onResize())
    }

    populateSelect() {
      const select = document.getElementById('profileSelect')
      if (!select) return
      select.innerHTML = ''
      this.catalog.forEach((profile, index) => {
        const option = document.createElement('option')
        option.value = profile.key
        option.textContent = profile.name + ' · ' + base(profile.targetImageUrl || profile.assetUrl || ('profile-' + (index + 1)))
        select.appendChild(option)
      })
    }
    updateSelectValue() {
      const select = document.getElementById('profileSelect')
      if (select && this.profile) select.value = this.profile.key
    }
    updateQuery(key) {
      if (!key || !history || typeof history.replaceState !== 'function') return
      try {
        const url = new URL(location.href)
        url.searchParams.set('profile', key)
        url.searchParams.set('target', key)
        history.replaceState({}, '', url.toString())
      } catch (_) {}
    }
    setTransformFromAlignment(value) {
      const a = align(value)
      this.transform.position = copy(a.position)
      this.transform.rotation = {
        x: Number(THREE.MathUtils.radToDeg(a.rotation.x).toFixed(3)),
        y: Number(THREE.MathUtils.radToDeg(a.rotation.y).toFixed(3)),
        z: Number(THREE.MathUtils.radToDeg(a.rotation.z).toFixed(3)),
      }
      const uniform = typeof a.scale === 'number'
      if (uniform) {
        this.transform.uniformScale = Number(a.scale || 1)
        this.transform.scale = { x: this.transform.uniformScale, y: this.transform.uniformScale, z: this.transform.uniformScale }
      } else {
        this.transform.scale = { x: Number(a.scale.x || 1), y: Number(a.scale.y || 1), z: Number(a.scale.z || 1) }
        this.transform.uniformScale = Number(((this.transform.scale.x + this.transform.scale.y + this.transform.scale.z) / 3).toFixed(4))
      }
      document.getElementById('nonUniformScale').checked = !uniform
      document.getElementById('nonUniformControls').classList.toggle('hidden', uniform)
      this.updateSliderPair('posX', 'posXNum', this.transform.position.x)
      this.updateSliderPair('posY', 'posYNum', this.transform.position.y)
      this.updateSliderPair('posZ', 'posZNum', this.transform.position.z)
      this.updateSliderPair('rotX', 'rotXNum', this.transform.rotation.x)
      this.updateSliderPair('rotY', 'rotYNum', this.transform.rotation.y)
      this.updateSliderPair('rotZ', 'rotZNum', this.transform.rotation.z)
      this.updateSliderPair('scaleUniform', 'scaleUniformNum', this.transform.uniformScale)
      this.updateSliderPair('scaleX', 'scaleXNum', this.transform.scale.x)
      this.updateSliderPair('scaleY', 'scaleYNum', this.transform.scale.y)
      this.updateSliderPair('scaleZ', 'scaleZNum', this.transform.scale.z)
    }
    clearPlane() {
      if (!this.targetPlane) return
      this.disposeObject(this.targetPlane)
      this.targetPlane = null
    }
    clearModel() {
      if (!this.modelRoot) return
      this.disposeObject(this.modelRoot)
      this.modelRoot = this.alignmentGroup = null
      this.modelLoaded = false
    }
    disposeObject(object) {
      if (!object) return
      object.traverse((child) => {
        if (child.geometry && typeof child.geometry.dispose === 'function') child.geometry.dispose()
        if (child.material) {
          const list = Array.isArray(child.material) ? child.material : [child.material]
          list.forEach((material) => {
            if (!material) return
            for (const key of ['map', 'lightMap', 'aoMap', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'displacementMap']) {
              if (material[key] && typeof material[key].dispose === 'function') material[key].dispose()
            }
            if (typeof material.dispose === 'function') material.dispose()
          })
        }
      })
      if (object.parent) object.parent.remove(object)
    }

    selectProfile(key, options = {}) {
      const src = this.catalogByKey.get(key) || this.catalog[0]
      if (!src) return
      if (!options.initial && this.profile && this.profile.key !== src.key) this.saveProfileState('switch')
      this.profileKey = src.key
      this.profileSource = options.initial ? this.profileSource : this.sourceFor(src.key)
      const saved = options.useSaved === false ? null : this.loadProfileState(src.key)
      this.profile = copy(src)
      this.profile.alignment = saved && saved.alignment ? align(saved.alignment) : copy(src.defaultAlignment || src.alignment)
      this.profile.defaultAlignment = copy(src.defaultAlignment || src.alignment)
      this.profile.savedState = saved || null
      this.profile.savedAt = saved && saved.updatedAt ? saved.updatedAt : null
      window.MODEL_RUNTIME_PROFILE = copy(this.profile)
      this.setTransformFromAlignment(this.profile.alignment)
      this.clearPlane()
      this.clearModel()
      this.updateProfilePanel()
      this.updateSelectValue()
      this.persistSelectedProfileKey(src.key)
      this.updateQuery(src.key)
      this.loadTargetImage(this.profile, ++this.targetLoadToken)
      this.loadModel(this.profile, ++this.modelLoadToken)
      this.applyTransform({ persist: false })
      this.updateOutput()
    }
    sourceFor(key) {
      if (this.qKey() === key) return 'query'
      if (this.storedKey() === key) return 'local-storage'
      const helper = typeof this.helpers.getProfile === 'function' ? this.helpers.getProfile() : null
      if (helper && this.keyFor(helper, 0) === key) return 'helper'
      return 'catalog'
    }
    updateProfilePanel() {
      if (!this.profile) return
      const saved = this.loadProfileState(this.profile.key)
      this.setText('profileName', this.profile.name || '-')
      this.setText('profileKey', this.profile.key || '-')
      this.setText('profileImage', base(this.profile.targetImageUrl) || this.profile.targetImageUrl || '-')
      this.setText('profileAsset', base(this.profile.assetUrl) || this.profile.assetUrl || '-')
      this.setText('profileWidth', meters(this.profile.targetPhysicalWidthMeters))
      this.setText('profileBaseScale', meters(this.profile.baseScaleMeters))
      this.setText('profileAlignment', alignSummary(this.profile.alignment))
      this.setText(
        'profileStorage',
        !this.storageOk
          ? 'localStorage unavailable'
          : saved && saved.updatedAt
            ? 'Saved ' + new Date(saved.updatedAt).toLocaleString()
            : 'Catalog default'
      )
      this.setText(
        'profileFootnote',
        !this.storageOk
          ? 'This browser session cannot persist edits locally.'
          : this.profileSource === 'query'
            ? 'Selected from the URL query string. Changes auto-save locally if storage is available.'
            : this.profileSource === 'local-storage'
              ? 'Restored from localStorage and ready for further alignment edits.'
              : this.profileSource === 'helper'
                ? 'Selected from the runtime helper catalog.'
                : 'Using the catalog default profile.'
      )
      this.setBadge(
        !this.storageOk
          ? 'No storage'
          : this.profileSource === 'local-storage'
            ? 'Restored'
            : this.profileSource === 'query'
              ? 'Query-selected'
              : saved && saved.alignment
                ? 'Saved'
                : 'Auto-save on'
      )
      this.setPreview(this.profile.thumbnailUrl || this.profile.targetImageUrl || '')
    }
    persistSelectedProfileKey(key) {
      this.write(this.selectedKey(), { key, updatedAt: new Date().toISOString() })
    }
    loadProfileState(key) {
      return this.read(this.skey(key))
    }
    saveProfileState(reason) {
      if (!this.profile) return false
      const payload = {
        profileKey: this.profile.key,
        profileName: this.profile.name,
        reason: reason || 'auto',
        updatedAt: new Date().toISOString(),
        alignment: copy(this.buildAlignmentConfig()),
      }
      const ok = this.write(this.skey(this.profile.key), payload)
      if (ok) {
        this.persistSelectedProfileKey(this.profile.key)
        this.profile.savedState = payload
        this.profile.savedAt = payload.updatedAt
        this.setBadge(reason === 'manual' ? 'Saved' : 'Auto-save on')
      }
      return ok
    }
    restoreProfileState() {
      if (!this.profile) return
      const saved = this.loadProfileState(this.profile.key)
      this.profileLoading = true
      this.setTransformFromAlignment(saved && saved.alignment ? saved.alignment : this.profile.defaultAlignment)
      this.profileLoading = false
      this.applyTransform({ persist: false, reason: 'restore' })
      this.setBadge(saved && saved.alignment ? 'Restored' : 'Catalog default')
      this.updateProfilePanel()
      this.updateOutput()
    }
    clearProfileState() {
      if (!this.profile) return
      this.remove(this.skey(this.profile.key))
      this.restoreProfileState()
      this.setBadge('Cleared')
    }

    loadTargetImage(profile, token) {
      const current = token || ++this.targetLoadToken
      if (!profile || !profile.targetImageUrl) {
        this.setBadge('No target image')
        return
      }
      new THREE.TextureLoader().load(
        profile.targetImageUrl,
        (texture) => {
          if (current !== this.targetLoadToken) {
            if (texture && typeof texture.dispose === 'function') texture.dispose()
            return
          }
          texture.encoding = THREE.sRGBEncoding
          const image = texture.image || {}
          const w = Number(image.width || 1)
          const h = Number(image.height || 1)
          this.targetHeight = this.targetWidth / (w / Math.max(1, h))
          const geo = new THREE.PlaneGeometry(this.targetWidth, this.targetHeight)
          const mat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide })
          this.targetPlane = new THREE.Mesh(geo, mat)
          this.scene.add(this.targetPlane)
          this.targetPlane.add(
            new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x00c870 }))
          )
        },
        undefined,
        (error) => {
          if (current !== this.targetLoadToken) return
          console.error('[Alignment] Failed to load target image:', error)
          this.setBadge('Preview failed')
        }
      )
    }
    loadModel(profile, token) {
      const current = token || ++this.modelLoadToken
      if (!profile || !profile.assetUrl) return
      new THREE.GLTFLoader().load(
        profile.assetUrl,
        (gltf) => {
          if (current !== this.modelLoadToken) {
            this.disposeObject(gltf.scene)
            return
          }
          const rig = window.ModelTransformHelpers.buildModelRig(gltf.scene, profile)
          this.modelRoot = rig.root
          this.alignmentGroup = rig.alignmentGroup
          this.scene.add(this.modelRoot)
          this.modelLoaded = true
          this.applyTransform({ persist: false })
        },
        undefined,
        (error) => {
          if (current !== this.modelLoadToken) return
          console.error('[Alignment] Failed to load model:', error)
        }
      )
    }

    setupControls() {
      const bind = (id, numId, fn) => {
        const slider = document.getElementById(id)
        const number = document.getElementById(numId)
        slider.addEventListener('input', () => {
          const value = parseFloat(slider.value)
          number.value = value
          fn(value)
        })
        number.addEventListener('input', () => {
          const value = parseFloat(number.value) || 0
          slider.value = value
          fn(value)
        })
      }

      bind('posX', 'posXNum', (v) => {
        this.transform.position.x = v
        this.applyTransform()
      })
      bind('posY', 'posYNum', (v) => {
        this.transform.position.y = v
        this.applyTransform()
      })
      bind('posZ', 'posZNum', (v) => {
        this.transform.position.z = v
        this.applyTransform()
      })
      bind('rotX', 'rotXNum', (v) => {
        this.transform.rotation.x = v
        this.applyTransform()
      })
      bind('rotY', 'rotYNum', (v) => {
        this.transform.rotation.y = v
        this.applyTransform()
      })
      bind('rotZ', 'rotZNum', (v) => {
        this.transform.rotation.z = v
        this.applyTransform()
      })
      bind('scaleUniform', 'scaleUniformNum', (v) => {
        this.transform.uniformScale = v
        if (!document.getElementById('nonUniformScale').checked) this.transform.scale = { x: v, y: v, z: v }
        this.applyTransform()
      })
      bind('scaleX', 'scaleXNum', (v) => {
        this.transform.scale.x = v
        this.applyTransform()
      })
      bind('scaleY', 'scaleYNum', (v) => {
        this.transform.scale.y = v
        this.applyTransform()
      })
      bind('scaleZ', 'scaleZNum', (v) => {
        this.transform.scale.z = v
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

    setupEvents() {
      document.getElementById('profileSelect').addEventListener('change', (event) => {
        this.selectProfile(event.target.value, { initial: false, useSaved: true })
      })
      document.getElementById('saveProfileBtn').addEventListener('click', () => {
        this.saveProfileState('manual')
        this.updateProfilePanel()
        this.updateOutput()
      })
      document.getElementById('restoreProfileBtn').addEventListener('click', () => this.restoreProfileState())
      document.getElementById('clearProfileBtn').addEventListener('click', () => this.clearProfileState())
      document.getElementById('resetBtn').addEventListener('click', () => this.resetTransform())
      document.getElementById('centerBtn').addEventListener('click', () => {
        this.transform.position = { x: 0, y: 0, z: 0 }
        this.updateSliderPair('posX', 'posXNum', 0)
        this.updateSliderPair('posY', 'posYNum', 0)
        this.updateSliderPair('posZ', 'posZNum', 0)
        this.applyTransform()
      })
      document.getElementById('flipXBtn').addEventListener('click', () => {
        this.transform.scale.x *= -1
        this.updateSliderPair('scaleX', 'scaleXNum', this.transform.scale.x)
        this.applyTransform()
      })
      document.getElementById('flipYBtn').addEventListener('click', () => {
        this.transform.scale.y *= -1
        this.updateSliderPair('scaleY', 'scaleYNum', this.transform.scale.y)
        this.applyTransform()
      })
      document.getElementById('flipZBtn').addEventListener('click', () => {
        this.transform.scale.z *= -1
        this.updateSliderPair('scaleZ', 'scaleZNum', this.transform.scale.z)
        this.applyTransform()
      })
      document.getElementById('rotate90XBtn').addEventListener('click', () => this.rotateBy('x', 90))
      document.getElementById('rotate90YBtn').addEventListener('click', () => this.rotateBy('y', 90))
      document.getElementById('rotate90ZBtn').addEventListener('click', () => this.rotateBy('z', 90))
      document.getElementById('outputFormat').addEventListener('change', () => this.updateOutput())
      document.getElementById('copyBtn').addEventListener('click', () => this.copyToClipboard())
    }

    applyTransform(options = {}) {
      if (!this.profile) return
      const alignment = this.buildAlignmentConfig()
      this.profile.alignment = copy(alignment)
      if (this.alignmentGroup) window.ModelTransformHelpers.applyAlignment(this.alignmentGroup, alignment)
      this.updateProfilePanel()
      this.updateOutput()
      if (options.persist !== false && !this.profileLoading) this.saveProfileState(options.reason || 'auto')
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
    getExportProfile() {
      if (!this.profile) return null
      const out = copy(this.profile)
      out.alignment = copy(this.buildAlignmentConfig())
      delete out.storageKey
      delete out.savedState
      delete out.savedAt
      delete out.defaultAlignment
      return out
    }
    updateOutput() {
      const format = document.getElementById('outputFormat').value
      const profile = this.getExportProfile()
      if (!profile) {
        document.getElementById('outputCode').textContent = ''
        return
      }
      const header = [
        '// ' + (profile.name || 'Target Profile') + ' (' + (profile.key || 'profile') + ')',
        '// Image: ' + (base(profile.targetImageUrl) || profile.targetImageUrl || '-'),
        '// Model: ' + (base(profile.assetUrl) || profile.assetUrl || '-'),
        '// Width: ' + meters(profile.targetPhysicalWidthMeters),
        '// Alignment: ' + alignSummary(profile.alignment),
      ].join('\n')
      let output = ''
      if (format === 'json') {
        output = JSON.stringify(profile, null, 2)
      } else if (format === 'js') {
        output = header + '\nwindow.MODEL_RUNTIME_PROFILE = ' + JSON.stringify(profile, null, 2)
      } else {
        const a = align(profile.alignment)
        const scaleCode =
          typeof a.scale === 'number'
            ? 'alignmentGroup.scale.setScalar(' + a.scale.toFixed(4) + ');'
            : 'alignmentGroup.scale.set(' +
              a.scale.x.toFixed(4) +
              ', ' +
              a.scale.y.toFixed(4) +
              ', ' +
              a.scale.z.toFixed(4) +
              ');'
        output =
          header +
          '\nalignmentGroup.position.set(' +
          a.position.x.toFixed(4) +
          ', ' +
          a.position.y.toFixed(4) +
          ', ' +
          a.position.z.toFixed(4) +
          ');\nalignmentGroup.rotation.set(' +
          a.rotation.x.toFixed(6) +
          ', ' +
          a.rotation.y.toFixed(6) +
          ', ' +
          a.rotation.z.toFixed(6) +
          ", 'XYZ');\n" +
          scaleCode
      }
      document.getElementById('outputCode').textContent = output
    }
    rotateBy(axis, delta) {
      this.transform.rotation[axis] = (this.transform.rotation[axis] + delta) % 360
      if (this.transform.rotation[axis] > 180) this.transform.rotation[axis] -= 360
      const s = axis.toUpperCase()
      this.updateSliderPair('rot' + s, 'rot' + s + 'Num', this.transform.rotation[axis])
      this.applyTransform()
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
      this.camera.aspect = container.clientWidth / container.clientHeight
      this.camera.updateProjectionMatrix()
      this.renderer.setSize(container.clientWidth, container.clientHeight)
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
})()
