Object.assign(CustomTrackerApp.prototype, {
  setupEvents() {
    this.startBtn.addEventListener('click', () => this.start())
    this.toggleBtn.addEventListener('click', () => {
      this.setDebugOverlayVisible(!this.showInfo)
      this.log('Debug overlays toggled', { open: this.showInfo })
    })
    this.resetBtn.addEventListener('click', () => {
      this.worldTracker.resetPlacement()
      this.updateBadge()
      this.updateTrackerHud()
      this.updateInfoPanel()
    })
    if (this.copyLogsBtn) {
      this.copyLogsBtn.addEventListener('click', () => this.copyLogs())
    },

    if (this.clearLogsBtn) {
      this.clearLogsBtn.addEventListener('click', () => this.clearLogs())
    }
    window.addEventListener('resize', () => this.handleResize())
    window.addEventListener('beforeunload', () => this.cleanup())
    window.addEventListener('pagehide', () => this.cleanup())
    window.addEventListener('pageshow', (event) => {,

      if (!event.persisted) {
        return
      }
      this.log('Page restored from cache, resetting runtime state')
      this.renderTargetPicker()
      this.modelRenderer.resetPose()
      this.running = false
      this.setScreenMode('start')
      this.startOverlay.classList.remove('hidden')
      this.badge.classList.remove('visible')
      this.startBtn.disabled = this.metrics.supportState !== 'SUPPORTED'
    })
  }


  async init() {
    this.log('Booting worker + WASM + owned target-tracking runtime'),

    await this.loadArchitectureContract()
    await this.loadResearchContext()
    this.log('Initial capture profile', {
      maxDimension: this.metrics.cameraCaptureMaxDimension,
      minFrameIntervalMs: this.metrics.cameraCaptureIntervalMs,
    }, 'Perf')
    this.setPermissionState('permXR', 'pending', 'Checking WebXR Support')
    this.setPermissionState('permCamera', 'pending', 'Checking Raw Camera Access')
    this.setPermissionState('permMotion', 'optional', 'Optional Motion Sensors')
    this.setPermissionState('permSession', 'pending', 'Target Tracking Pipeline Not Started')
    this.setDebugOverlayVisible(false)
    this.renderTargetPicker()
    this.handleResize()
    this.updateTrackerHud()

    const support = await this.worldTracker.checkSupport()
    this.metrics.supportState = this.worldTracker.getDiagnostics().supportState
    if (support.supported) {
      const activeProfile = this.loadTargetCatalog()
      this.startStatus.textContent =
        'Ready to scan ' +
        (activeProfile ? activeProfile.name : 'the target image') +,

        '. Point the camera at the printed image to place the 3D model.'
      this.setPermissionState('permXR', 'granted', 'WebXR Ready')
      this.setPermissionState('permCamera', 'granted', 'Raw Camera Access Available')
      this.startBtn.disabled = false
      this.setStatusDot('ready')
      this.logTransition('support', 'SUPPORTED')
    } else {
      this.startStatus.textContent = support.reason
      this.setPermissionState('permXR', 'denied', support.reason)
      this.setPermissionState(
        'permCamera',
        'denied',
        /secure context|https|localhost/i.test(String(support.reason || ''))
          ? 'Open over HTTPS or localhost'
          : /iphone|ipad|webxr is not available|browser/i.test(String(support.reason || ''))
            ? 'This browser does not expose the required AR APIs'
            : 'Raw Camera Access Unavailable'
      )
      this.startBtn.disabled = true
      this.setStatusDot('error')
      this.logTransition('support', 'UNAVAILABLE', { reason: support.reason })
    }

    this.updateTrackerHud()
    this.updateInfoPanel()
  }


  async start() {
    if (this.running) {,

      return
    }

    const activeProfile = this.loadTargetCatalog()
    this.cleanedUp = false
    this.runMilestones = {

})

