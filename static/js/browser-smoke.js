(function () {
  const statusEl = document.getElementById('status')
  const outputEl = document.getElementById('output')

  function log(message, data) {
    const line = typeof data === 'undefined' ? message : message + ' ' + JSON.stringify(data)
    outputEl.textContent += '\n' + line
  }

  async function reportStatus(state, payload) {
    if (typeof window.__smokeReport === 'function') {
      try {
        await window.__smokeReport(state, payload)
        return
      } catch (error) {
      }
    }

    try {
      await fetch('/smoke-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: state, ...(payload || {}) }),
        keepalive: true,
      })
    } catch (error) {
      log('report-error', { message: error.message })
    }
  }

  async function setStatus(state, payload) {
    document.body.dataset.status = state
    statusEl.dataset.state = state
    statusEl.textContent = state
    if (payload) {
      outputEl.textContent = JSON.stringify(payload, null, 2)
    }
    await reportStatus(state, payload)
  }

  function makeFrame(width, height, shiftX, shiftY) {
    const pixels = new Uint8Array(width * height * 4)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4
        const cx = x + shiftX
        const cy = y + shiftY
        const checker = ((Math.floor(cx / 6) + Math.floor(cy / 6)) % 2) === 0
        const stripe = (cx % 13 === 0 || cy % 11 === 0)
        const spot = ((cx - width * 0.55) * (cx - width * 0.55) + (cy - height * 0.42) * (cy - height * 0.42)) < 120
        const value = stripe ? 255 : spot ? 230 : checker ? 200 : 24
        pixels[index] = value
        pixels[index + 1] = checker ? value : Math.max(0, value - 30)
        pixels[index + 2] = spot ? 255 : Math.max(0, value - 50)
        pixels[index + 3] = 255
      }
    }
    return pixels
  }

  function postVisualFrame(worker, width, height, shiftX, shiftY, timestampMs) {
    const pixels = makeFrame(width, height, shiftX, shiftY)
    worker.postMessage({
      type: 'visual-frame',
      payload: {
        width,
        height,
        sourceWidth: width * 4,
        sourceHeight: height * 4,
        captureMs: 2.5,
        timestampMs,
        pixels,
      },
    })
  }

  function postMeasurement(worker, timestampMs) {
    worker.postMessage({
      type: 'measurement',
      payload: {
        id: 1,
        source: 'surface',
        matrix: [
          1, 0, 0, 0,
          0, 1, 0, 0,
          0, 0, 1, 0,
          0.05, 0.02, -0.8, 1,
        ],
        confidence: 0.82,
        hasPlacement: false,
        timestampMs,
        sentAtMs: performance.now(),
      },
    })
  }

  async function run() {
    await setStatus('RUNNING', { phase: 'worker-bootstrap' })
    const worker = new Worker('/static/js/tracking-pose-worker.js')
    const events = []

    function waitFor(predicate, timeoutMs, label) {
      return new Promise((resolve, reject) => {
        const startedAt = performance.now()
        const timer = setInterval(() => {
          const workerFailure = events.find((message) => message.type === 'error')
          if (workerFailure) {
            clearInterval(timer)
            reject(new Error('Worker error during ' + label + ': ' + JSON.stringify(workerFailure.payload || {})))
            return
          }
          const match = events.find(predicate)
          if (match) {
            clearInterval(timer)
            resolve(match)
            return
          }
          if (performance.now() - startedAt > timeoutMs) {
            clearInterval(timer)
            reject(new Error('Timed out waiting for worker event during ' + label + '. Events: ' + JSON.stringify(events.map((message) => ({ type: message.type, payload: message.payload })))) )
          }
        }, 20)
      })
    }

    worker.onerror = async (event) => {
      await setStatus('FAIL', {
        pass: false,
        stage: 'worker-error',
        message: event.message || 'Worker error',
        filename: event.filename || '',
        lineno: event.lineno || 0,
      })
    }

    worker.onmessageerror = async () => {
      await setStatus('FAIL', { pass: false, stage: 'worker-message-error', message: 'Worker message deserialization failed.' })
    }

    worker.onmessage = (event) => {
      const message = event.data || {}
      events.push(message)
      log('event', { type: message.type, payload: message.payload })
    }

    worker.postMessage({ type: 'init', config: { featureCellSize: 16, featuresPerCell: 2 } })
    const ready = await waitFor((message) => message.type === 'ready', 4000, 'worker-ready')

    postVisualFrame(worker, 80, 60, 0, 0, 1000)
    const visual1 = await waitFor((message) => message.type === 'visual-update' && message.payload.frames >= 1, 4000, 'visual-frame-1')

    postVisualFrame(worker, 80, 60, 2, 1, 1120)
    const visual2 = await waitFor((message) => message.type === 'visual-update' && message.payload.frames >= 2, 4000, 'visual-frame-2')

    postMeasurement(worker, 1200)
    const pose = await waitFor((message) => message.type === 'pose-update', 4000, 'pose-update')

    worker.terminate()

    const assertions = {
      ready: Array.isArray(ready.payload.kernels) && ready.payload.kernels.includes('cornerScore8'),
      features: Number(visual2.payload.featureCount || 0) >= 10,
      tracks: Number(visual2.payload.trackCount || 0) >= 10,
      matches: Number(visual2.payload.matchCount || 0) >= 4,
      keyframes: Number(visual2.payload.keyframeCount || 0) >= 1,
      map: ['TRACKING', 'MAPPED', 'RELOCALIZING'].includes(String(visual2.payload.mapState || '')),
      relocalization: Number(visual2.payload.relocalizationScore || 0) >= 0,
      pose: Number(pose.payload.confidence || 0) > 0,
    }

    const result = {
      pass: Object.values(assertions).every(Boolean),
      assertions,
      ready: ready.payload,
      visual1: visual1.payload,
      visual2: visual2.payload,
      pose: pose.payload,
    }

    await setStatus(result.pass ? 'PASS' : 'FAIL', result)
  }

  run().catch(async (error) => {
    await setStatus('FAIL', { pass: false, error: error.message || String(error), eventCount: document.getElementById('output').textContent.split('event').length - 1 })
  })
})()
