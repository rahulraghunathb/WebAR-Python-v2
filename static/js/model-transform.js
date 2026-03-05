(function () {
  const DEFAULT_ALIGNMENT = {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: 1,
  }

  const DEFAULT_PROFILE = {
    assetUrl: '/static/assets/ranger-3d-model.glb',
    targetImageUrl: '/static/assets/ranger-base-image.jpg',
    baseScaleMeters: 0.5,
    uprightRotation: { x: Math.PI / 2, y: 0, z: 0 },
    alignment: DEFAULT_ALIGNMENT,
  }

  function cloneVector3(source, fallback) {
    const value = source || fallback || { x: 0, y: 0, z: 0 }
    return {
      x: Number(value.x || 0),
      y: Number(value.y || 0),
      z: Number(value.z || 0),
    }
  }

  function cloneScale(source) {
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

  function cloneAlignment(source) {
    return {
      position: cloneVector3(source && source.position, DEFAULT_ALIGNMENT.position),
      rotation: cloneVector3(source && source.rotation, DEFAULT_ALIGNMENT.rotation),
      scale: cloneScale(source && source.scale),
    }
  }

  function mergeProfile(source) {
    const profile = source || {}
    return {
      assetUrl: profile.assetUrl || DEFAULT_PROFILE.assetUrl,
      targetImageUrl: profile.targetImageUrl || DEFAULT_PROFILE.targetImageUrl,
      baseScaleMeters: Number(profile.baseScaleMeters || DEFAULT_PROFILE.baseScaleMeters),
      uprightRotation: cloneVector3(profile.uprightRotation, DEFAULT_PROFILE.uprightRotation),
      alignment: cloneAlignment(profile.alignment),
    }
  }

  function applyAlignment(group, alignment) {
    if (!group) {
      return
    }

    const normalized = cloneAlignment(alignment)
    group.position.set(
      normalized.position.x,
      normalized.position.y,
      normalized.position.z
    )
    group.rotation.set(
      normalized.rotation.x,
      normalized.rotation.y,
      normalized.rotation.z,
      'XYZ'
    )

    if (typeof normalized.scale === 'number') {
      group.scale.setScalar(normalized.scale)
    } else {
      group.scale.set(
        normalized.scale.x,
        normalized.scale.y,
        normalized.scale.z
      )
    }
  }

  function buildModelRig(rawScene, profileInput) {
    const profile = mergeProfile(profileInput || window.MODEL_RUNTIME_PROFILE)
    const box = new THREE.Box3().setFromObject(rawScene)
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const minY = box.min.y
    const maxDim = Math.max(size.x, size.y, size.z) || 1
    const scaleFactor = profile.baseScaleMeters / maxDim

    rawScene.position.set(-center.x, -minY, -center.z)

    const normalizedRoot = new THREE.Group()
    normalizedRoot.scale.setScalar(scaleFactor)
    normalizedRoot.add(rawScene)

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
      uprightGroup: uprightRoot,
      normalizedRoot: normalizedRoot,
      rawScene: rawScene,
      metadata: {
        size: { x: size.x, y: size.y, z: size.z },
        center: { x: center.x, y: center.y, z: center.z },
        minY: minY,
        maxDim: maxDim,
        scaleFactor: scaleFactor,
      },
    }
  }

  window.MODEL_RUNTIME_PROFILE = mergeProfile(window.MODEL_RUNTIME_PROFILE)
  window.ModelTransformHelpers = {
    getProfile() {
      window.MODEL_RUNTIME_PROFILE = mergeProfile(window.MODEL_RUNTIME_PROFILE)
      return mergeProfile(window.MODEL_RUNTIME_PROFILE)
    },
    cloneAlignment,
    applyAlignment,
    buildModelRig,
  }
})()
