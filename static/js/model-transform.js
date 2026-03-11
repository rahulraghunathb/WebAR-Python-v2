(function () {
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

  function normalizeAlignment(source) {
    return {
      position: normalizeVector3(source && source.position, DEFAULT_ALIGNMENT.position),
      rotation: normalizeVector3(source && source.rotation, DEFAULT_ALIGNMENT.rotation),
      scale: normalizeScale(source && source.scale),
    }
  }

  function normalizeProfile(source) {
    const profile = source || {}
    return {
      assetUrl: profile.assetUrl || DEFAULT_PROFILE.assetUrl,
      targetImageUrl: profile.targetImageUrl || DEFAULT_PROFILE.targetImageUrl,
      targetPhysicalWidthMeters: Number(
        profile.targetPhysicalWidthMeters || DEFAULT_PROFILE.targetPhysicalWidthMeters
      ),
      baseScaleMeters: Number(profile.baseScaleMeters || DEFAULT_PROFILE.baseScaleMeters),
      uprightRotation: normalizeVector3(profile.uprightRotation, DEFAULT_PROFILE.uprightRotation),
      alignment: normalizeAlignment(profile.alignment),
    }
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
    const profile = normalizeProfile(profileInput || window.MODEL_RUNTIME_PROFILE)
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

  window.MODEL_RUNTIME_PROFILE = normalizeProfile(window.MODEL_RUNTIME_PROFILE)
  window.ModelTransformHelpers = {
    getProfile() {
      window.MODEL_RUNTIME_PROFILE = normalizeProfile(window.MODEL_RUNTIME_PROFILE)
      return normalizeProfile(window.MODEL_RUNTIME_PROFILE)
    },
    normalizeAlignment,
    applyAlignment,
    buildModelRig,
  }
})()



