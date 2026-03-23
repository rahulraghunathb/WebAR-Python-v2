CustomTrackerApp.prototype.loadTargetCatalog = function() {
    if (
      !window.ModelTransformHelpers ||
      typeof window.ModelTransformHelpers.getProfiles !== 'function'
    ) {
      this.targetProfiles = []
      return null
    }

    this.targetProfiles = window.ModelTransformHelpers.getProfiles()
    const activeProfile = window.ModelTransformHelpers.getProfile()
    this.activeTargetId = activeProfile.id
    return activeProfile
};

CustomTrackerApp.prototype.renderTargetPicker = function() {
    if (!this.targetGrid || !this.targetPicker) {
      return
    }

    const activeProfile = this.loadTargetCatalog()
    this.targetGrid.innerHTML = ''

    if (!this.targetProfiles.length || !activeProfile) {
      return
    }

    const hasMultipleTargets = this.targetProfiles.length > 1
    this.targetPicker.classList.toggle('single-target', !hasMultipleTargets)
    this.targetGrid.classList.toggle('hidden', !hasMultipleTargets)
    if (this.targetPickerTitle) {
      this.targetPickerTitle.textContent = hasMultipleTargets ? 'Choose Image Target' : 'Target Image'
    }

    if (hasMultipleTargets) {
      this.targetProfiles.forEach((profile) => {
        const card = document.createElement('button')
        card.type = 'button'
        card.className = 'target-card' + (profile.id === this.activeTargetId ? ' active' : '')
        card.dataset.targetId = profile.id
        card.innerHTML =
          '<img class="target-card-thumb" alt="" src="' + profile.thumbnailUrl + '">' +
          '<div class="target-card-name">' + profile.name + '</div>' +
          '<div class="target-card-copy">' + profile.description + '</div>' +
          '<div class="target-card-meta">' + Math.round(profile.targetPhysicalWidthMeters * 100) + ' cm target</div>'
        card.addEventListener('click', () => {
          this.selectTargetProfile(profile.id)
        })
        this.targetGrid.appendChild(card)
      })
    }

    this.updateTargetPreview(activeProfile)
};

CustomTrackerApp.prototype.updateAlignmentToolLink = function(profile) {
    if (!this.alignmentToolLink || !profile) {
      return
    }
    this.alignmentToolLink.href =
      '/static/alignment-tool/index.html?target=' + encodeURIComponent(profile.id)
};

CustomTrackerApp.prototype.updateTargetPreview = function(profile) {
    if (!profile) {
      return
    }
    if (this.targetPreviewImage) {
      this.targetPreviewImage.src = profile.thumbnailUrl || profile.targetImageUrl || ''
    }
    if (this.targetPreviewName) {
      this.targetPreviewName.textContent = profile.name
    }
    if (this.targetPreviewMeta) {
      this.targetPreviewMeta.textContent =
        'Use this printed image target. Width: ' +
        Math.round(profile.targetPhysicalWidthMeters * 100) +
        ' cm. ' +
        (profile.description || '')
    }
    if (this.targetPreviewHint) {
      this.targetPreviewHint.innerHTML =
        '<strong>Scan hint:</strong> ' + (profile.scanHint || 'Hold the full target in frame.')
    }
    this.updateAlignmentToolLink(profile)
};

CustomTrackerApp.prototype.selectTargetProfile = function(targetId, options = {}) {
    if (
      !window.ModelTransformHelpers ||
      typeof window.ModelTransformHelpers.setActiveTarget !== 'function'
    ) {
      return null
    }
    const profile = window.ModelTransformHelpers.setActiveTarget(targetId, {
      persist: options.persist !== false,
      updateUrl: options.updateUrl !== false,
    })
    this.activeTargetId = profile.id
    this.metrics.targetName = profile.name
    this.renderTargetPicker()
    this.updateTrackerHud()
    this.updateInfoPanel()
    this.log('Selected target profile', {
      id: profile.id,
      name: profile.name,
      widthM: Number(profile.targetPhysicalWidthMeters.toFixed(3)),
    }, 'Target')
    return profile
};

CustomTrackerApp.prototype.describeGuidance = function(world) {
    const profile = (
      window.ModelTransformHelpers &&
      typeof window.ModelTransformHelpers.getProfile === 'function'
    )
      ? window.ModelTransformHelpers.getProfile()
      : null

    if (!this.running) {
      return profile && profile.scanHint
        ? profile.scanHint
        : 'Hold the full target in frame with even lighting.'
    }

    if (world.worldState === 'TRACKING' && world.targetVisible) {
      return 'Target locked. Keep the image in view for the most stable overlay.'
    }

    if (world.targetState === 'DETECTED') {
      return 'Target detected. Hold steady for a fresh pose solve.'
    }

    if (world.targetState === 'REACQUIRING' || world.worldState === 'RELOCALIZING') {
      return 'Reacquiring target. Move slightly closer and bring the full image back into frame.'
    }

    if (world.visualQuality < 0.35 || world.visualFeatureCount < 10) {
      return 'Improve lighting or move closer so the tracker can see stronger image features.'
    }

    return profile && profile.scanHint
      ? profile.scanHint
      : 'Scan the target image until the tracker confirms a lock.'
};

CustomTrackerApp.prototype.loadArchitectureContract = async function() {
    try {
      const response = await fetch('/status', { cache: 'no-store' })
      if (!response.ok) {
        throw new Error('Status request failed with ' + response.status)
      }
      const status = await response.json()
      this.metrics.buildSignature = status.build_signature || '-'
      this.metrics.trackingMode = status.tracking_mode || '-'
      this.metrics.researchTrack = status.research_track || '-'
      this.metrics.featureCount = Number(status.feature_count || 0)
      this.metrics.requiredCapabilityCount = Number(status.required_capability_count || 0)
      this.metrics.requiredCapabilities = Array.isArray(status.required_runtime_capabilities) ? status.required_runtime_capabilities.slice() : []
      this.metrics.smokeReportEndpoint = status.smoke_report_endpoint || '-'
      this.metrics.frontendTelemetryEndpoint = status.frontend_telemetry_endpoint || '/frontend-telemetry'
      this.metrics.noFallbacks = Boolean(status.no_fallbacks)
      this.metrics.assetMode = status.asset_mode || '-'
      this.metrics.backendLoggingMode = status.backend_logging_mode || '-'
      this.log('Loaded architecture contract', {
        build: this.metrics.buildSignature,
        trackingMode: this.metrics.trackingMode,
        featureCount: this.metrics.featureCount,
        requiredCapabilityCount: this.metrics.requiredCapabilityCount,
        noFallbacks: this.metrics.noFallbacks,
        backendLoggingMode: this.metrics.backendLoggingMode,
      }, 'Contract')
    } catch (error) {
      this.log('Failed to load architecture contract', { message: error.message }, 'Contract')
    }
};

CustomTrackerApp.prototype.loadResearchContext = async function() {
    try {
      const [programResponse, experimentResponse] = await Promise.all([
        fetch('/api/research-program', { cache: 'no-store' }),
        fetch('/api/experiments/current', { cache: 'no-store' }),
      ])
      if (!programResponse.ok || !experimentResponse.ok) {
        throw new Error('Research context request failed')
      }
      const programPayload = await programResponse.json()
      const experimentPayload = await experimentResponse.json()
      const experiment = experimentPayload.experiment || {}
      this.experimentContext.experimentId = experiment.experimentId || '-'
      this.experimentContext.programVersion = programPayload.program_version || '-'
      this.experimentContext.hypothesis = experiment.hypothesis || ''
      this.experimentContext.presetId = experiment.presetId || '-'
      this.experimentContext.deviceLabel = experiment.deviceLabel || 'mobile-phone'
      this.experimentContext.runTag = experiment.runTag || '-'
      this.experimentContext.operatorNote = experiment.operatorNote || ''
      this.experimentContext.successCriteria = experiment.successCriteria || ''
      this.experimentContext.targetId = experiment.targetId || '-'
      if (
        this.experimentContext.targetId &&
        this.experimentContext.targetId !== '-' &&
        window.ModelTransformHelpers &&
        typeof window.ModelTransformHelpers.setActiveTarget === 'function'
      ) {
        window.ModelTransformHelpers.setActiveTarget(this.experimentContext.targetId, {
          persist: true,
          updateUrl: false,
        })
      }
      this.log('Loaded research context', {
        experimentId: this.experimentContext.experimentId,
        programVersion: this.experimentContext.programVersion,
        targetId: this.experimentContext.targetId,
      }, 'Lab')
    } catch (error) {
      this.log('Failed to load research context', { message: error.message }, 'Lab')
    }
};

CustomTrackerApp.prototype.shouldForwardTransition = function(key, value) {
    if (key === 'camera-access') {
      return ['ERROR', 'NO_CAMERA_ACCESS', 'NO_CAMERA_IMAGE', 'NO_CAMERA_SIZE'].includes(value)
    }
    return [
      'support',
      'session',
      'world',
      'target',
      'hit-test',
      'anchor',
      'worker',
      'wasm',
      'visual',
      'imu',
    ].includes(key)
};

CustomTrackerApp.prototype.syncWorldMetrics = function(diagnostics) {
    copySelectedFields(this.metrics, diagnostics, WORLD_METRIC_FIELDS)
};

CustomTrackerApp.prototype.buildBackendTelemetryPayload = function(kind, extra = {}) {
    const world = this.worldTracker.getDiagnostics()
    const render = this.modelRenderer.getDiagnostics()

    return {
      kind: kind,
      seq: ++this.telemetrySequence,
      sessionId: this.backendSessionId,
      sentAtIso: new Date().toISOString(),
      elapsedMs: roundedNumber(performance.now() - this.runtimeStartAt, 2),
      buildSignature: this.metrics.buildSignature,
      trackingMode: this.metrics.trackingMode,
      researchTrack: this.metrics.researchTrack,
      experimentId: this.experimentContext.experimentId,
      programVersion: this.experimentContext.programVersion,
      hypothesis: this.experimentContext.hypothesis,
      presetId: this.experimentContext.presetId,
      deviceLabel: this.experimentContext.deviceLabel,
      runTag: this.experimentContext.runTag,
      operatorNote: this.experimentContext.operatorNote,
      successCriteria: this.experimentContext.successCriteria,
      targetId: this.experimentContext.targetId || this.activeTargetId || world.targetName,
      sessionState: world.sessionState,
      referenceSpace: world.referenceSpace,
      worldState: world.worldState,
      targetState: world.targetState,
      targetName: world.targetName,
      targetVisible: Boolean(world.targetVisible),
      targetUpdates: Number(world.targetUpdates || 0),
      targetMeasuredWidthM: roundedNumber(world.targetMeasuredWidthM, 3),
      targetIndex: typeof world.targetIndex === 'number' ? world.targetIndex : -1,
      targetMatchCount: Number(world.targetMatchCount || 0),
      targetInlierCount: Number(world.targetInlierCount || 0),
      targetInlierRatio: roundedNumber(
        world.targetInlierRatio || (world.targetMatchCount ? world.targetInlierCount / world.targetMatchCount : 0),
        3
      ),
      targetConfidence: roundedNumber(world.targetConfidence, 3),
      targetReprojectionPx: roundedNumber(world.targetReprojectionPx, 3),
      targetStableFrames: Number(world.targetStableFrames || 0),
      targetPrelockMisses: Number(world.targetPrelockMisses || 0),
      targetRejectReason: String(world.targetRejectReason || 'NONE'),
      targetBestInliers: Number(world.targetBestInliers || 0),
      targetRefinedInliers: Number(world.targetRefinedInliers || 0),
      targetRawMatchCount: Number(world.targetRawMatchCount || 0),
      targetReciprocalMatchCount: Number(world.targetReciprocalMatchCount || 0),
      targetMatchStrategy: String(world.targetMatchStrategy || 'NONE'),
      targetReferenceReady: Boolean(world.targetReferenceReady),
      targetReferenceFeatures: Number(world.targetReferenceFeatures || 0),
      hitTestState: world.hitTestState,
      anchorState: world.anchorState,
      workerState: world.workerState,
      wasmState: world.wasmState,
      cameraAccessState: world.cameraAccessState,
      visualState: world.visualState,
      visualFeatureCount: world.visualFeatureCount,
      visualQuality: roundedNumber(world.visualQuality, 3),
      visualProcMs: roundedNumber(world.visualProcMs, 3),
      visualCaptureMs: roundedNumber(world.visualCaptureMs, 3),
      trackCount: world.trackCount,
      averageTrackAge: roundedNumber(world.averageTrackAge, 3),
      maxTrackAge: roundedNumber(world.maxTrackAge, 3),
      longTrackRatio: roundedNumber(world.longTrackRatio, 3),
      matchCount: world.matchCount,
      keyframeCount: world.keyframeCount,
      landmarkCount: world.landmarkCount,
      stableLandmarkCount: Number(world.stableLandmarkCount || 0),
      staleLandmarkCount: Number(world.staleLandmarkCount || 0),
      staleLandmarkRatio: roundedNumber(world.staleLandmarkRatio, 3),
      keyframeGrowthPerSec: roundedNumber(world.keyframeGrowthPerSec, 3),
      landmarkGrowthPerSec: roundedNumber(world.landmarkGrowthPerSec, 3),
      motionObservability: roundedNumber(world.motionObservability, 3),
      mapState: world.mapState,
      relocalizationScore: roundedNumber(world.relocalizationScore, 3),
      relocalizationAttemptCount: Number(world.relocalizationAttemptCount || 0),
      relocalizationRecoveryCount: Number(world.relocalizationRecoveryCount || 0),
      lastRelocalizationDurationMs: roundedNumber(world.lastRelocalizationDurationMs, 2),
      currentRelocalizationDurationMs: roundedNumber(world.currentRelocalizationDurationMs, 2),
      filterConfidence: roundedNumber(world.filterConfidence, 3),
      surfaceHits: Number(world.surfaceHits || 0),
      hasPlacement: Boolean(world.hasPlacement),
      xrFps: Number(world.xrFps || 0),
      frameTimeMs: roundedNumber(render.lastFrameMs, 2),
      workerProcMs: roundedNumber(world.workerProcMs, 3),
      workerLatencyMs: roundedNumber(world.workerLatencyMs, 3),
      measurementDeltaTranslationM: roundedNumber(world.measurementDeltaTranslationM || world.residualTranslationM, 4),
      measurementDeltaRotationDeg: roundedNumber(world.measurementDeltaRotationDeg || world.residualRotationDeg, 3),
      cameraAverageCaptureMs: roundedNumber(world.cameraAverageCaptureMs, 3),
      cameraCaptureIntervalMs: Number(world.cameraCaptureIntervalMs || 0),
      cameraCaptureMaxDimension: Number(world.cameraCaptureMaxDimension || 0),
      cameraSkippedThrottle: Number(world.cameraSkippedThrottle || 0),
      cameraSkippedBusy: Number(world.cameraSkippedBusy || 0),
      cameraFramePending: Boolean(world.cameraFramePending),
      source: extra.source || 'runtime',
      message: extra.message,
      value: typeof extra.value === 'undefined' ? undefined : extra.value,
    }
};

CustomTrackerApp.prototype.sendBackendTelemetry = function(kind, extra = {}) {
    const endpoint = this.metrics.frontendTelemetryEndpoint || '/frontend-telemetry'
    if (!endpoint || endpoint === '-') {
      return
    }

    const payload = this.buildBackendTelemetryPayload(kind, extra)
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch((error) => {
      console.warn('[BackendTelemetry] send failed', error)
    })
};

CustomTrackerApp.prototype.emitRunMilestone = function(flag, value, message) {
    if (this.runMilestones[flag]) {
      return
    }
    this.runMilestones[flag] = true
    this.sendBackendTelemetry('milestone', {
      source: 'lab-run',
      value: value,
      message: message,
    })
};
