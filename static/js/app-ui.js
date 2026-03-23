CustomTrackerApp.prototype.setText = function(id, value) {
    const element = document.getElementById(id)
    if (element) {
      element.textContent = value
    }
};

CustomTrackerApp.prototype.setTrackerCard = function(baseId, state, label, meta) {
    const card = document.getElementById(baseId)
    const stateEl = document.getElementById(baseId + 'State')
    const metaEl = document.getElementById(baseId + 'Meta')
    if (card) {
      card.dataset.state = state
    }
    if (stateEl) {
      stateEl.textContent = label
    }
    if (metaEl) {
      metaEl.textContent = meta
    }
};

CustomTrackerApp.prototype.setPermissionState = function(elementId, state, label) {
    const element = document.getElementById(elementId)
    if (!element) {
      return
    }

    element.classList.remove('granted', 'denied', 'optional')
    if (state && state !== 'pending') {
      element.classList.add(state)
    }
    element.textContent = label
};

CustomTrackerApp.prototype.setDebugOverlayVisible = function(visible) {
    this.showInfo = visible
    this.panel.classList.toggle('visible', visible)
    this.trackerHud.classList.toggle('visible', visible)
    this.toggleBtn.classList.toggle('active', visible)
    this.toggleBtn.textContent = visible ? 'Hide Debug' : 'Show Debug'
    this.toggleBtn.setAttribute('aria-pressed', visible ? 'true' : 'false')
    if (visible) {
      this.lastDebugUiUpdateAt = 0
      this.updateLocalInfo()
      this.updateInfoPanel()
      this.updateTrackerHud()
    }
};

CustomTrackerApp.prototype.setScreenMode = function(mode) {
    const nextMode = mode === 'tracking' ? 'screen-tracking' : 'screen-start'
    document.body.classList.remove('screen-start', 'screen-tracking')
    document.body.classList.add(nextMode)
};

CustomTrackerApp.prototype.handleWorldStateChange = function(state, diagnostics) {
    this.syncWorldMetrics(diagnostics)

    this.logTransition('session', diagnostics.sessionState)
    this.logTransition('world', state)
    this.logTransition('target', diagnostics.targetState)
    this.logTransition('hit-test', diagnostics.hitTestState)
    this.logTransition('anchor', diagnostics.anchorState)
    this.logTransition('worker', diagnostics.workerState)
    this.logTransition('wasm', diagnostics.wasmState)
    this.logTransition('camera-access', diagnostics.cameraAccessState)
    this.logTransition('visual', diagnostics.visualState)

    if (diagnostics.targetState === 'DETECTED') {
      this.emitRunMilestone('firstDetection', 'first-detection', 'First target detection observed')
    }
    if (state === 'TRACKING' && diagnostics.targetVisible) {
      this.emitRunMilestone('firstLock', 'first-lock', 'First target lock achieved')
    }
    if (
      this.runMilestones.firstLock &&
      !this.runMilestones.firstLoss &&
      (diagnostics.targetState === 'LOST' || diagnostics.targetState === 'REACQUIRING')
    ) {
      this.emitRunMilestone('firstLoss', 'lock-loss', 'First lock loss or reacquire event observed')
    }

    if (CAMERA_ACCESS_ACTIVE_STATES.has(diagnostics.cameraAccessState)) {
      this.setPermissionState('permCamera', 'granted', 'Raw Camera Frames Active')
    }

    if (state === 'ENDED') {
      this.running = false
      this.setScreenMode('start')
      this.startOverlay.classList.remove('hidden')
      this.renderTargetPicker()
      this.startStatus.textContent = 'AR session ended. Tap start to re-enter worker + WASM owned target tracking.'
      this.startBtn.disabled = this.metrics.supportState !== 'SUPPORTED'
      this.setPermissionState('permSession', 'pending', 'Target Tracking Pipeline Not Started')
      this.setPermissionState('permCamera', 'pending', 'Raw Camera Access Available')
      this.badge.classList.remove('visible')
      this.setStatusDot(this.metrics.supportState === 'SUPPORTED' ? 'ready' : 'error')
    } else if (state === 'ERROR') {
      this.running = false
      this.setScreenMode('start')
      this.startOverlay.classList.remove('hidden')
      this.renderTargetPicker()
      this.startStatus.textContent = 'Target tracking encountered an error. Tap start to try again.'
      this.startBtn.disabled = this.metrics.supportState !== 'SUPPORTED'
      this.badge.classList.remove('visible')
      this.setStatusDot('error')
    } else if (state === 'TRACKING') {
      this.setStatusDot('active')
    } else if (state === 'RELOCALIZING' || state === 'SCANNING') {
      this.setStatusDot('ready')
    }

    this.updateBadge()
    this.updateTrackerHud()
    this.updateInfoPanel()
};

CustomTrackerApp.prototype.setStatusDot = function(state) {
    this.statusDot.classList.remove('ready', 'active', 'error')
    if (state) {
      this.statusDot.classList.add(state)
    }
};

CustomTrackerApp.prototype.updateBadge = function() {
    const world = this.worldTracker.getDiagnostics()
    if (!this.running) {
      this.badge.classList.remove('visible')
      return
    }

    if (world.worldState === 'TRACKING' && world.targetVisible) {
      this.badge.textContent = 'Target Locked ' + Math.round(world.filterConfidence * 100) + '% / visual ' + Math.round(world.visualQuality * 100) + '%'
      this.badge.classList.add('visible')
      return
    }

    if (
      world.targetState === 'DETECTED' ||
      world.targetState === 'REACQUIRING' ||
      world.worldState === 'RELOCALIZING' ||
      (world.hasPlacement && !world.targetVisible)
    ) {
      this.badge.textContent = this.describeGuidance(world)
      this.badge.classList.add('visible')
      return
    }

    this.badge.textContent = this.describeGuidance(world)
    this.badge.classList.add('visible')
};

CustomTrackerApp.prototype.handleResize = function() {
    this.modelRenderer.resize(window.innerWidth, window.innerHeight)
};
