class CameraDiagnosticsApp {
  constructor() {
    this.video = document.getElementById('previewVideo')
    this.startBtn = document.getElementById('startBtn')
    this.stopBtn = document.getElementById('stopBtn')
    this.captureBtn = document.getElementById('captureBtn')
    this.cameraSelect = document.getElementById('cameraSelect')
    this.statusNotice = document.getElementById('statusNotice')
    this.sharpnessValue = document.getElementById('sharpnessValue')
    this.sharpnessMeta = document.getElementById('sharpnessMeta')
    this.streamValue = document.getElementById('streamValue')
    this.streamMeta = document.getElementById('streamMeta')
    this.qualityValue = document.getElementById('qualityValue')
    this.qualityMeta = document.getElementById('qualityMeta')
    this.metricList = document.getElementById('metricList')
    this.analysisCanvas = document.getElementById('analysisCanvas')
    this.edgeCanvas = document.getElementById('edgeCanvas')
    this.analysisMeta = document.getElementById('analysisMeta')
    this.edgeMeta = document.getElementById('edgeMeta')
    this.scoreFill = document.getElementById('scoreFill')
    this.resultChip = document.getElementById('resultChip')

    this.analysisContext = this.analysisCanvas.getContext('2d', { willReadFrequently: true })
    this.edgeContext = this.edgeCanvas.getContext('2d', { willReadFrequently: true })
    this.sampleCanvas = document.createElement('canvas')
    this.sampleContext = this.sampleCanvas.getContext('2d', { willReadFrequently: true })

    this.stream = null
    this.videoTrack = null
    this.streamInfo = null
    this.analysisTimer = 0
    this.analysisIntervalMs = 450
    this.lastSharpness = 0

    this.bindEvents()
    this.populateDevices()
    this.renderMetrics()
  }

  bindEvents() {
    this.startBtn.addEventListener('click', () => this.start())
    this.stopBtn.addEventListener('click', () => this.stop())
    this.captureBtn.addEventListener('click', () => this.captureFrame())
    this.cameraSelect.addEventListener('change', () => {
      if (this.stream) {
        this.start()
      }
    })
    window.addEventListener('beforeunload', () => this.stop())
  }

  async populateDevices() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
      return
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const videoInputs = devices.filter((device) => device.kind === 'videoinput')
      if (!videoInputs.length) {
        return
      }
      const currentValue = this.cameraSelect.value
      this.cameraSelect.innerHTML = '<option value="">Default environment camera</option>'
      videoInputs.forEach((device, index) => {
        const option = document.createElement('option')
        option.value = device.deviceId
        option.textContent = device.label || 'Camera ' + (index + 1)
        this.cameraSelect.appendChild(option)
      })
      this.cameraSelect.value = currentValue
    } catch (error) {
      this.setNotice('Could not enumerate cameras: ' + error.message, 'warn')
    }
  }

  async start() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      this.setNotice('This browser does not expose getUserMedia, so the comparison test cannot run here.', 'bad')
      return
    }

    this.stop()
    this.setNotice('Requesting the browser camera stream...', 'warn')

    const selectedDeviceId = this.cameraSelect.value
    const constraints = {
      video: selectedDeviceId
        ? {
            deviceId: { exact: selectedDeviceId },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30 },
          }
        : {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30 },
          },
      audio: false,
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints)
      this.video.srcObject = this.stream
      this.videoTrack = this.stream.getVideoTracks()[0] || null
      await this.video.play()
      await this.populateDevices()
      this.updateStreamInfo()
      this.setRunningUi(true)
      this.setNotice('Browser camera stream is running. Hold steady for a second so autofocus can settle, then compare this feed to the WebXR AR page.', 'good')
      this.runAnalysisLoop()
    } catch (error) {
      this.stream = null
      this.videoTrack = null
      this.setRunningUi(false)
      this.setNotice('Could not start the camera stream: ' + error.message, 'bad')
    }
  }

  stop() {
    if (this.analysisTimer) {
      window.clearTimeout(this.analysisTimer)
      this.analysisTimer = 0
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop())
    }
    this.stream = null
    this.videoTrack = null
    this.video.srcObject = null
    this.streamInfo = null
    this.lastSharpness = 0
    this.setRunningUi(false)
    this.updateHud('Idle', 'No active browser camera stream.', '-', 'Start the stream to inspect sharpness.')
    this.renderMetrics()
  }

  setRunningUi(running) {
    this.startBtn.classList.toggle('hidden', running)
    this.stopBtn.classList.toggle('hidden', !running)
    this.captureBtn.classList.toggle('hidden', !running)
  }

  setNotice(message, tone) {
    this.statusNotice.textContent = message
    this.statusNotice.classList.remove('good')
    if (tone === 'good') {
      this.statusNotice.classList.add('good')
    }
  }

  updateHud(streamState, streamMeta, qualityValue, qualityMeta) {
    this.streamValue.textContent = streamState
    this.streamMeta.textContent = streamMeta
    this.qualityValue.textContent = qualityValue
    this.qualityMeta.textContent = qualityMeta
  }

  updateStreamInfo() {
    const settings = this.videoTrack && typeof this.videoTrack.getSettings === 'function'
      ? this.videoTrack.getSettings()
      : {}
    const capabilities = this.videoTrack && typeof this.videoTrack.getCapabilities === 'function'
      ? this.videoTrack.getCapabilities()
      : {}
    const label = this.videoTrack ? (this.videoTrack.label || 'Unnamed camera') : '-'
    this.streamInfo = {
      label,
      settings,
      capabilities,
    }
    this.renderMetrics()
  }

  runAnalysisLoop() {
    if (!this.stream || !this.video.videoWidth || !this.video.videoHeight) {
      this.analysisTimer = window.setTimeout(() => this.runAnalysisLoop(), this.analysisIntervalMs)
      return
    }

    const metrics = this.analyzeCurrentFrame()
    this.lastSharpness = metrics.sharpness
    this.sharpnessValue.textContent = this.formatNumber(metrics.sharpness, 1)
    this.sharpnessMeta.textContent = metrics.summary
    this.scoreFill.style.width = Math.max(0, Math.min(100, metrics.scorePercent)) + '%'
    this.applyQualityInterpretation(metrics)
    this.renderMetrics(metrics)
    this.analysisTimer = window.setTimeout(() => this.runAnalysisLoop(), this.analysisIntervalMs)
  }

  analyzeCurrentFrame() {
    const width = this.video.videoWidth
    const height = this.video.videoHeight
    const maxDimension = 320
    const scale = Math.min(1, maxDimension / Math.max(width, height))
    const sampleWidth = Math.max(48, Math.round(width * scale))
    const sampleHeight = Math.max(36, Math.round(height * scale))

    this.sampleCanvas.width = sampleWidth
    this.sampleCanvas.height = sampleHeight
    this.sampleContext.drawImage(this.video, 0, 0, sampleWidth, sampleHeight)
    const image = this.sampleContext.getImageData(0, 0, sampleWidth, sampleHeight)
    const gray = new Float32Array(sampleWidth * sampleHeight)
    for (let index = 0; index < gray.length; index += 1) {
      const base = index * 4
      gray[index] =
        image.data[base] * 0.299 +
        image.data[base + 1] * 0.587 +
        image.data[base + 2] * 0.114
    }

    let sum = 0
    let sumSquares = 0
    let count = 0
    for (let y = 1; y < sampleHeight - 1; y += 1) {
      for (let x = 1; x < sampleWidth - 1; x += 1) {
        const center = gray[y * sampleWidth + x]
        const laplacian =
          gray[y * sampleWidth + (x - 1)] +
          gray[y * sampleWidth + (x + 1)] +
          gray[(y - 1) * sampleWidth + x] +
          gray[(y + 1) * sampleWidth + x] -
          center * 4
        sum += laplacian
        sumSquares += laplacian * laplacian
        count += 1
      }
    }

    const mean = count ? sum / count : 0
    const variance = count ? Math.max(0, sumSquares / count - mean * mean) : 0
    const scorePercent = Math.round(Math.max(0, Math.min(100, (variance / 1600) * 100)))
    const band =
      variance >= 900 ? 'sharp' :
      variance >= 450 ? 'usable' :
      variance >= 220 ? 'soft' :
      'very soft'

    return {
      width: sampleWidth,
      height: sampleHeight,
      sharpness: variance,
      scorePercent,
      band,
      summary: 'Estimated as ' + band + ' from live edge contrast in a downsampled frame.',
    }
  }

  applyQualityInterpretation(metrics) {
    let chipClass = 'warn'
    let chipText = 'Borderline For Comparison'
    let qualityMeta = 'The browser feed is usable, but you should compare text edges and printed corners carefully.'

    if (metrics.band === 'sharp') {
      chipClass = 'good'
      chipText = 'Browser Feed Looks Sharp'
      qualityMeta = 'If immersive AR still looks soft at the same distance, the blur is likely introduced by WebXR passthrough.'
    } else if (metrics.band === 'usable') {
      chipClass = 'warn'
      chipText = 'Browser Feed Looks Acceptable'
      qualityMeta = 'This is probably good enough for testing, but very fine detail may still suffer.'
    } else {
      chipClass = 'bad'
      chipText = 'Browser Feed Looks Soft'
      qualityMeta = 'If this page is already soft, tracker failures are likely dominated by optics, focus distance, or lighting.'
    }

    this.resultChip.className = 'status-chip ' + chipClass
    this.resultChip.textContent = chipText
    this.updateHud(
      'Live',
      this.describeStream(),
      metrics.band.toUpperCase(),
      qualityMeta
    )
  }

  describeStream() {
    const settings = (this.streamInfo && this.streamInfo.settings) || {}
    const resolution =
      settings.width && settings.height ? settings.width + ' x ' + settings.height : 'unknown resolution'
    const fps = settings.frameRate ? Math.round(settings.frameRate) + ' fps' : 'unknown fps'
    return resolution + ' | ' + fps
  }

  renderMetrics(metrics) {
    const settings = (this.streamInfo && this.streamInfo.settings) || {}
    const capabilities = (this.streamInfo && this.streamInfo.capabilities) || {}
    const rows = [
      ['Camera', this.streamInfo ? this.streamInfo.label : '-'],
      ['Resolution', settings.width && settings.height ? settings.width + ' x ' + settings.height : '-'],
      ['Frame Rate', settings.frameRate ? this.formatNumber(settings.frameRate, 1) + ' fps' : '-'],
      ['Facing Mode', settings.facingMode || '-'],
      ['Focus Mode', Array.isArray(capabilities.focusMode) ? capabilities.focusMode.join(', ') : (settings.focusMode || 'not exposed')],
      ['Zoom', typeof settings.zoom === 'number' ? this.formatNumber(settings.zoom, 2) : 'not exposed'],
      ['Torch', typeof settings.torch === 'boolean' ? String(settings.torch) : 'not exposed'],
      ['Exposure', typeof settings.exposureMode === 'string' ? settings.exposureMode : 'not exposed'],
      ['White Balance', typeof settings.whiteBalanceMode === 'string' ? settings.whiteBalanceMode : 'not exposed'],
      ['Live Sharpness', metrics ? this.formatNumber(metrics.sharpness, 1) : this.formatNumber(this.lastSharpness, 1)],
      ['Interpretation', metrics ? metrics.band : '-'],
    ]

    this.metricList.innerHTML = rows
      .map((row) =>
        '<div class="metric-row">' +
          '<div class="metric-name">' + this.escapeHtml(row[0]) + '</div>' +
          '<div class="metric-value">' + this.escapeHtml(String(row[1])) + '</div>' +
        '</div>'
      )
      .join('')
  }

  captureFrame() {
    if (!this.stream || !this.video.videoWidth || !this.video.videoHeight) {
      return
    }
    const width = this.video.videoWidth
    const height = this.video.videoHeight
    this.analysisCanvas.width = width
    this.analysisCanvas.height = height
    this.analysisContext.drawImage(this.video, 0, 0, width, height)

    const image = this.analysisContext.getImageData(0, 0, width, height)
    const edgeImage = this.edgeContext.createImageData(width, height)
    const gray = new Float32Array(width * height)
    for (let index = 0; index < gray.length; index += 1) {
      const base = index * 4
      gray[index] =
        image.data[base] * 0.299 +
        image.data[base + 1] * 0.587 +
        image.data[base + 2] * 0.114
    }

    let edgeSum = 0
    let edgeCount = 0
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const gx =
          -gray[(y - 1) * width + (x - 1)] - 2 * gray[y * width + (x - 1)] - gray[(y + 1) * width + (x - 1)] +
          gray[(y - 1) * width + (x + 1)] + 2 * gray[y * width + (x + 1)] + gray[(y + 1) * width + (x + 1)]
        const gy =
          -gray[(y - 1) * width + (x - 1)] - 2 * gray[(y - 1) * width + x] - gray[(y - 1) * width + (x + 1)] +
          gray[(y + 1) * width + (x - 1)] + 2 * gray[(y + 1) * width + x] + gray[(y + 1) * width + (x + 1)]
        const magnitude = Math.min(255, Math.sqrt(gx * gx + gy * gy))
        const base = (y * width + x) * 4
        edgeImage.data[base] = magnitude
        edgeImage.data[base + 1] = magnitude
        edgeImage.data[base + 2] = magnitude
        edgeImage.data[base + 3] = 255
        edgeSum += magnitude
        edgeCount += 1
      }
    }

    this.edgeCanvas.width = width
    this.edgeCanvas.height = height
    this.edgeContext.putImageData(edgeImage, 0, 0)
    const avgEdge = edgeCount ? edgeSum / edgeCount : 0
    const capturedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    this.analysisMeta.textContent =
      'Captured at ' + capturedAt + ' | Live sharpness ' + this.formatNumber(this.lastSharpness, 1) + '. Inspect printed text and target corners for edge crispness.'
    this.edgeMeta.textContent =
      'Average edge magnitude ' + this.formatNumber(avgEdge, 1) + '. Higher values generally mean the browser stream preserved more contrast.'
  }

  formatNumber(value, digits = 1) {
    const number = Number(value || 0)
    return number.toFixed(digits)
  }

  escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.cameraDiagnosticsApp = new CameraDiagnosticsApp()
})