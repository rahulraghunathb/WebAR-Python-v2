(function () {
  const ACTIVE_TARGET_STORAGE_KEY = 'webar-active-target-id'
  const PROFILE_OVERRIDES_STORAGE_KEY = 'webar-target-profile-overrides'

  const DEFAULT_ALIGNMENT = {
    position: { x: 0.01, y: 0.04, z: 0.13 },
    rotation: { x: 1.570796, y: 0, z: 0 },
    scale: 2.04,
  }

  const DEFAULT_TARGET_CATALOG = [
    {
      id: 'ranger-poster',
      name: 'Ranger Poster',
      description: 'High-feature poster target with a strong lock profile.',
      thumbnailUrl: '/static/assets/ranger-base-image.jpg',
      scanHint: 'Start 30 to 60 cm away and keep the full poster inside the frame.',
      assetUrl: '/static/assets/ranger-3d-model.glb',
      targetImageUrl: '/static/assets/ranger-base-image.jpg',
      targetPhysicalWidthMeters: 0.2,
      baseScaleMeters: 0.22,
      uprightRotation: { x: 0, y: 0, z: 0 },
      alignment: DEFAULT_ALIGNMENT,
    },
  ]

  function normalizeVector3(source, fallback) {
    const value = source || fallback || { x: 0, y: 0, z: 0 }
    return {
      x: Number(value.x || 0),
      y: Number(value.y || 0),
      z: Number(value.z || 0),
    }
  }

  function normalizeScale(source) {
    if (typeof source === 'number') {
      return Number(source)
    }
    if (source && typeof source === 'object') {
      return {
        x: Number(source.x || 1),
        y: Number(source.y || 1),
        z: Number(source.z || 1),
      }
    }
    return 1
  }

  function normalizeAlignment(source, fallback) {
    const base = fallback || DEFAULT_ALIGNMENT
    return {
      position: normalizeVector3(source && source.position, base.position),
      rotation: normalizeVector3(source && source.rotation, base.rotation),
      scale: normalizeScale(source && typeof source.scale !== 'undefined' ? source.scale : base.scale),
    }
  }

  function normalizeProfile(source, fallback) {
    const base = fallback || DEFAULT_TARGET_CATALOG[0]
    const profile = source || {}
    const targetImageUrl = profile.targetImageUrl || base.targetImageUrl
    return {
      id: String(profile.id || base.id || 'default-target'),
      name: String(profile.name || base.name || 'Untitled Target'),
      description: String(profile.description || base.description || ''),
      thumbnailUrl: String(profile.thumbnailUrl || targetImageUrl || base.thumbnailUrl || ''),
      scanHint: String(
        profile.scanHint ||
        base.scanHint ||
        'Hold the full image target in frame and keep lighting even during lock-on.'
      ),
      assetUrl: String(profile.assetUrl || base.assetUrl || ''),
      targetImageUrl: String(targetImageUrl || ''),
      targetPhysicalWidthMeters: Number(
        profile.targetPhysicalWidthMeters || base.targetPhysicalWidthMeters || 0.2
      ),
      baseScaleMeters: Number(profile.baseScaleMeters || base.baseScaleMeters || 0.22),
      uprightRotation: normalizeVector3(profile.uprightRotation, base.uprightRotation),
      alignment: normalizeAlignment(profile.alignment, base.alignment),
    }
  }

  function cloneCatalogEntry(entry) {
    return normalizeProfile(entry, entry)
  }

  function mergeProfile(base, patch) {
    return normalizeProfile(
      {
        ...base,
        ...(patch || {}),
        alignment: {
          ...(base && base.alignment ? base.alignment : {}),
          ...(patch && patch.alignment ? patch.alignment : {}),
        },
      },
      base
    )
  }

  function dedupeCatalog(entries) {
    const seen = new Set()
    const deduped = []
    entries.forEach((entry) => {
      if (!entry || seen.has(entry.id)) {
        return
      }
      seen.add(entry.id)
      deduped.push(entry)
    })
    return deduped
  }

  function canUseLocalStorage() {
    try {
      return typeof window !== 'undefined' && Boolean(window.localStorage)
    } catch (error) {
      return false
    }
  }

  function readStorageValue(key, fallback) {
    if (!canUseLocalStorage()) {
      return fallback
    }
    try {
      const value = window.localStorage.getItem(key)
      return value === null ? fallback : value
    } catch (error) {
      return fallback
    }
  }

  function writeStorageValue(key, value) {
    if (!canUseLocalStorage()) {
      return
    }
    try {
      window.localStorage.setItem(key, value)
    } catch (error) {
      console.warn('[ModelTransformHelpers] Failed to persist value', { key, error })
    }
  }

  function parseStoredOverrides() {
    const raw = readStorageValue(PROFILE_OVERRIDES_STORAGE_KEY, '')
    if (!raw) {
      return {}
    }
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch (error) {
      return {}
    }
  }

  function readQueryTargetId() {
    try {
      const url = new URL(window.location.href)
      return url.searchParams.get('target') || ''
    } catch (error) {
      return ''
    }
  }

  function normalizeCatalog(source) {
    if (!Array.isArray(source) || !source.length) {
      return DEFAULT_TARGET_CATALOG.map((entry) => cloneCatalogEntry(entry))
    }
    return dedupeCatalog(
      source.map((entry, index) => normalizeProfile(entry, DEFAULT_TARGET_CATALOG[index] || DEFAULT_TARGET_CATALOG[0]))
    )
  }

  function buildCatalog() {
    const configuredCatalog = Array.isArray(window.MODEL_TARGET_CATALOG) && window.MODEL_TARGET_CATALOG.length
      ? window.MODEL_TARGET_CATALOG
      : window.MODEL_RUNTIME_PROFILE && typeof window.MODEL_RUNTIME_PROFILE === 'object'
        ? [window.MODEL_RUNTIME_PROFILE]
        : DEFAULT_TARGET_CATALOG
    const catalog = normalizeCatalog(configuredCatalog)
    const overrides = parseStoredOverrides()
    return catalog.map((entry) => mergeProfile(entry, overrides[entry.id]))
  }

  function getProfiles() {
    window.MODEL_TARGET_CATALOG = buildCatalog()
    return window.MODEL_TARGET_CATALOG.map((entry) => cloneCatalogEntry(entry))
  }

  function resolveTargetId(requestedTargetId, catalog) {
    const profiles = catalog && catalog.length ? catalog : getProfiles()
    const requested = String(
      requestedTargetId ||
      window.MODEL_ACTIVE_TARGET_ID ||
      readQueryTargetId() ||
      readStorageValue(ACTIVE_TARGET_STORAGE_KEY, '') ||
      ''
    )
    const active = profiles.find((entry) => entry.id === requested)
    return active ? active.id : profiles[0].id
  }

  function syncUrlTargetId(targetId) {
    if (!window.history || typeof window.history.replaceState !== 'function') {
      return
    }
    try {
      const url = new URL(window.location.href)
      url.searchParams.set('target', targetId)
      window.history.replaceState({}, '', url.toString())
    } catch (error) {
      console.warn('[ModelTransformHelpers] Failed to update target query param', error)
    }
  }

  function getProfile(targetId) {
    const profiles = getProfiles()
    const resolvedTargetId = resolveTargetId(targetId, profiles)
    const profile = profiles.find((entry) => entry.id === resolvedTargetId) || profiles[0]
    window.MODEL_ACTIVE_TARGET_ID = profile.id
    window.MODEL_RUNTIME_PROFILE = cloneCatalogEntry(profile)
    return cloneCatalogEntry(profile)
  }

  function getProfileIndex(targetId) {
    const profiles = getProfiles()
    const resolvedTargetId = resolveTargetId(targetId, profiles)
    const index = profiles.findIndex((entry) => entry.id === resolvedTargetId)
    return index >= 0 ? index : 0
  }

  function setActiveTarget(targetId, options) {
    const settings = {
      persist: !options || options.persist !== false,
      updateUrl: !options || options.updateUrl !== false,
    }
    const profile = getProfile(targetId)
    if (settings.persist) {
      writeStorageValue(ACTIVE_TARGET_STORAGE_KEY, profile.id)
    }
    if (settings.updateUrl) {
      syncUrlTargetId(profile.id)
    }
    return cloneCatalogEntry(profile)
  }

  function updateProfile(targetId, patch, options) {
    const settings = {
      persist: !options || options.persist !== false,
      setActive: !options || options.setActive !== false,
    }
    const profiles = getProfiles()
    const resolvedTargetId = resolveTargetId(targetId, profiles)
    const index = profiles.findIndex((entry) => entry.id === resolvedTargetId)
    if (index < 0) {
      return getProfile()
    }

    const nextProfile = mergeProfile(profiles[index], patch)
    profiles[index] = nextProfile
    window.MODEL_TARGET_CATALOG = profiles.map((entry) => cloneCatalogEntry(entry))

    if (settings.persist) {
      const overrides = parseStoredOverrides()
      overrides[resolvedTargetId] = nextProfile
      writeStorageValue(PROFILE_OVERRIDES_STORAGE_KEY, JSON.stringify(overrides))
    }

    if (settings.setActive) {
      return setActiveTarget(resolvedTargetId)
    }

    return cloneCatalogEntry(nextProfile)
  }

  function applyAlignment(group, alignment) {
    if (!group) {
      return
    }

    const normalized = normalizeAlignment(alignment)
    group.position.set(normalized.position.x, normalized.position.y, normalized.position.z)
    group.rotation.set(
      normalized.rotation.x,
      normalized.rotation.y,
      normalized.rotation.z,
      'XYZ'
    )

    if (typeof normalized.scale === 'number') {
      group.scale.setScalar(normalized.scale)
    } else {
      group.scale.set(normalized.scale.x, normalized.scale.y, normalized.scale.z)
    }
  }

  function buildModelRig(scene, profileInput) {
    const profile = normalizeProfile(profileInput || getProfile())
    const box = new THREE.Box3().setFromObject(scene)
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const minY = box.min.y
    const maxDim = Math.max(size.x, size.y, size.z) || 1
    const scaleFactor = profile.baseScaleMeters / maxDim

    scene.position.set(-center.x, -minY, -center.z)

    const normalizedRoot = new THREE.Group()
    normalizedRoot.scale.setScalar(scaleFactor)
    normalizedRoot.add(scene)

    const uprightRoot = new THREE.Group()
    uprightRoot.rotation.set(
      profile.uprightRotation.x,
      profile.uprightRotation.y,
      profile.uprightRotation.z,
      'XYZ'
    )
    uprightRoot.add(normalizedRoot)

    const alignmentRoot = new THREE.Group()
    alignmentRoot.add(uprightRoot)
    applyAlignment(alignmentRoot, profile.alignment)

    return {
      root: alignmentRoot,
      alignmentGroup: alignmentRoot,
      normalizedRoot: normalizedRoot,
      uprightRoot: uprightRoot,
      rawScene: scene,
      metadata: {
        size: { x: size.x, y: size.y, z: size.z },
        center: { x: center.x, y: center.y, z: center.z },
        minY: minY,
        maxDim: maxDim,
        scaleFactor: scaleFactor,
      },
    }
  }

  window.MODEL_TARGET_CATALOG = buildCatalog()
  window.MODEL_RUNTIME_PROFILE = getProfile()
  window.ModelTransformHelpers = {
    getProfiles,
    getProfile,
    getProfileIndex,
    setActiveTarget,
    updateProfile,
    normalizeAlignment,
    applyAlignment,
    buildModelRig,
    syncUrlTargetId,
  }
})()
