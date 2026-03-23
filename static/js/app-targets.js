Object.assign(CustomTrackerApp.prototype, {
      started: false,
      firstDetection: false,
      firstLock: false,
      firstLoss: false,
    }
    this.startBtn.disabled = true
    this.badge.classList.remove('visible')
      this.startStatus.textContent =
        'Loading ' + (activeProfile ? activeProfile.name : 'target image') + '...'
    this.setPermissionState('permSession', 'pending', 'Preparing Target Tracking Pipeline')

    try {
      await this.modelRenderer.waitForModel()

      this.startStatus.textContent = 'Requesting optional motion sensor access...',

      const imuGranted = await this.imuManager.requestPermission()
      if (imuGranted) {
        this.metrics.imuState = 'ACTIVE'
        this.setPermissionState('permMotion', 'granted', 'Motion Sensors Ready')
        this.modelRenderer.setIMUManager(this.imuManager)
        this.logTransition('imu', 'ACTIVE')
      } else {
        this.metrics.imuState = 'UNAVAILABLE'
        this.setPermissionState('permMotion', 'optional', 'Motion Sensors Unavailable')
        this.logTransition('imu', 'UNAVAILABLE')
      }

      this.startStatus.textContent =
        'Starting AR for ' + (activeProfile ? activeProfile.name : 'the target image') + '...'
      await this.worldTracker.start()
      this.running = true
      this.setScreenMode('tracking')
      this.startOverlay.classList.add('hidden')
      this.setPermissionState('permSession', 'granted', 'Target Tracking Pipeline Active')
      this.setPermissionState('permCamera', 'granted', 'Raw Camera Frames Active')
      this.setStatusDot('active')
      this.handleResize()
      this.lastProfileTuneAt = 0
      this.loop()
      this.emitRunMilestone('started', 'run-start', 'Experiment run started')
      this.updateBadge()
      this.updateTrackerHud()
      this.updateInfoPanel()
      this.maybeTuneCaptureProfile(true)
    } catch (error) {
      console.error('[CustomTracker] Start failed', error)
      this.log('Start failed', { message: error.message }, 'App')
      this.sendBackendTelemetry('error', { source: 'start', message: error.message })
      this.running = false
      this.setScreenMode('start')
      this.setStatusDot('error')
      this.setPermissionState('permSession', 'denied', 'Target Tracking Pipeline Failed')
      this.setPermissionState('permCamera', 'denied', 'Raw Camera Access Failed')
      this.setPermissionState('permXR', 'denied', 'XR Session Failed')
      this.startStatus.textContent = error.message,

      this.startBtn.disabled = this.metrics.supportState !== 'SUPPORTED'
      this.updateTrackerHud()
      this.updateInfoPanel()
    }
  }


  cleanup() {,

    if (this.cleanedUp) {
      return
    }

    this.cleanedUp = true
    this.running = false
    if (this.loopHandle) {
      cancelAnimationFrame(this.loopHandle)
      this.loopHandle = 0
    }
    this.badge.classList.remove('visible')
    this.setScreenMode('start')
    this.imuManager.stopListening()
    this.worldTracker.stop().catch(() => {})
  }


  loop() {
    if (!this.running) {
      return
    }

    this.loopHandle = requestAnimationFrame(() => this.loop())
    const now = performance.now(),

    this.syncMetrics()
    this.maybeTuneCaptureProfile(false)
    if (this.showInfo && now - this.lastDebugUiUpdateAt >= this.debugUiIntervalMs) {
      this.lastDebugUiUpdateAt = now
      this.updateLocalInfo()
      this.updateInfoPanel()
      this.updateTrackerHud()
    }
    this.reportRuntimeSummary(now)
  }


  syncMetrics() {
    const world = this.worldTracker.getDiagnostics()
    const render = this.modelRenderer.getDiagnostics()

    this.syncWorldMetrics(world)
    this.metrics.frameTimeMs = render.lastFrameMs
    this.metrics.renderState = render.renderState
  }


  updateLocalInfo() {
    this.setText('infoFps', this.metrics.xrFps || 0),

    const imuActive = this.imuManager.isActive
    this.metrics.imuState = imuActive
      ? 'ACTIVE'
      : this.metrics.imuState === 'UNAVAILABLE'
        ? 'UNAVAILABLE'
        : 'IDLE'

    this.setText('infoImuStatus', imuActive ? 'Active' : 'Inactive')

    if (imuActive) {
      const orient = this.imuManager.orientation
      this.setText('infoImuAlpha', orient.alpha.toFixed(1))
      this.setText('infoImuBeta', orient.beta.toFixed(1))
      this.setText('infoImuGamma', orient.gamma.toFixed(1))
      this.setText('infoImuVel', this.imuManager.linVel.length().toFixed(3) + ' m/s')
      this.setText('infoImuDelta', this.imuManager.getRotationMagnitude().toFixed(1) + ' deg')
    } else {
      this.setText('infoImuAlpha', '-')
      this.setText('infoImuBeta', '-')
      this.setText('infoImuGamma', '-')
      this.setText('infoImuVel', '-')
      this.setText('infoImuDelta', '-')
    }
  }

}

document.addEventListener('DOMContentLoaded', () => {
  window.app = new CustomTrackerApp()
})

})

