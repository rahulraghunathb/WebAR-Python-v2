class XRCameraFramePipeline {
  constructor(options = {}) {
    this.onLog = typeof options.onLog === 'function' ? options.onLog : null
    this.maxDimension = Number(options.maxDimension || 96)
    this.minFrameIntervalMs = Number(options.minFrameIntervalMs || 220)

    this.session = null
    this.renderer = null
    this.gl = null
    this.xrGlBinding = null

    this.program = null
    this.vertexBuffer = null
    this.framebuffer = null
    this.outputTexture = null
    this.outputWidth = 0
    this.outputHeight = 0

    this.lastCaptureAt = 0
    this.captures = 0
    this.skippedThrottle = 0
    this.skippedBusy = 0
    this.lastCaptureMs = 0
    this.averageCaptureMs = 0
    this.inFlight = false
    this.state = 'IDLE'
  }

  log(message, data) {
    if (this.onLog) {
      this.onLog(message, data)
      return
    }
    if (typeof data === 'undefined') {
      console.info('[XRCameraFramePipeline]', message)
      return
    }
    console.info('[XRCameraFramePipeline]', message, data)
  }

  checkSupport() {
    return typeof XRWebGLBinding !== 'undefined'
  }

  setConfig(options = {}) {
    const nextMaxDimension = Number(options.maxDimension || this.maxDimension)
    const nextMinFrameIntervalMs = Number(options.minFrameIntervalMs || this.minFrameIntervalMs)
    const changed =
      nextMaxDimension !== this.maxDimension || nextMinFrameIntervalMs !== this.minFrameIntervalMs

    this.maxDimension = nextMaxDimension
    this.minFrameIntervalMs = nextMinFrameIntervalMs

    if (changed) {
      this.log('XR camera pipeline config updated', {
        maxDimension: this.maxDimension,
        minFrameIntervalMs: this.minFrameIntervalMs,
      })
    }
  }

  async start(session, renderer) {
    if (!this.checkSupport()) {
      throw new Error('XR raw camera access is not available in this browser.')
    }

    if (!session || !renderer) {
      throw new Error('Session and renderer are required for camera frame capture.')
    }

    this.session = session
    this.renderer = renderer
    this.gl = renderer.getContext()
    if (!this.gl) {
      throw new Error('WebGL context is not available for camera frame capture.')
    }

    if (typeof this.gl.makeXRCompatible === 'function') {
      await this.gl.makeXRCompatible()
    }

    this.xrGlBinding = new XRWebGLBinding(session, this.gl)
    this.setupProgram()
    this.inFlight = false
    this.state = 'READY'
    this.log('XR raw camera pipeline ready', {
      maxDimension: this.maxDimension,
      minFrameIntervalMs: this.minFrameIntervalMs,
    })
  }

  stop() {
    const gl = this.gl
    if (gl) {
      if (this.outputTexture) {
        gl.deleteTexture(this.outputTexture)
      }
      if (this.framebuffer) {
        gl.deleteFramebuffer(this.framebuffer)
      }
      if (this.vertexBuffer) {
        gl.deleteBuffer(this.vertexBuffer)
      }
      if (this.program) {
        gl.deleteProgram(this.program)
      }
    }

    this.program = null
    this.vertexBuffer = null
    this.framebuffer = null
    this.outputTexture = null
    this.outputWidth = 0
    this.outputHeight = 0
    this.xrGlBinding = null
    this.gl = null
    this.renderer = null
    this.session = null
    this.lastCaptureAt = 0
    this.captures = 0
    this.skippedThrottle = 0
    this.skippedBusy = 0
    this.lastCaptureMs = 0
    this.averageCaptureMs = 0
    this.inFlight = false
    this.state = 'IDLE'
  }

  setupProgram() {
    if (this.program || !this.gl) {
      return
    }

    const gl = this.gl
    const vertexShader = this.compileShader(
      gl.VERTEX_SHADER,
      [
        'attribute vec2 aPosition;',
        'varying vec2 vUv;',
        'void main(void) {',
        '  vUv = (aPosition + 1.0) * 0.5;',
        '  gl_Position = vec4(aPosition, 0.0, 1.0);',
        '}',
      ].join('\n')
    )
    const fragmentShader = this.compileShader(
      gl.FRAGMENT_SHADER,
      [
        'precision mediump float;',
        'varying vec2 vUv;',
        'uniform sampler2D uTexture;',
        'void main(void) {',
        '  gl_FragColor = texture2D(uTexture, vec2(vUv.x, 1.0 - vUv.y));',
        '}',
      ].join('\n')
    )

    const program = gl.createProgram()
    gl.attachShader(program, vertexShader)
    gl.attachShader(program, fragmentShader)
    gl.linkProgram(program)

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) || 'Unable to link camera frame pipeline shader.'
      gl.deleteProgram(program)
      gl.deleteShader(vertexShader)
      gl.deleteShader(fragmentShader)
      throw new Error(message)
    }

    gl.deleteShader(vertexShader)
    gl.deleteShader(fragmentShader)

    this.program = program
    this.positionLocation = gl.getAttribLocation(program, 'aPosition')
    this.textureLocation = gl.getUniformLocation(program, 'uTexture')

    const vertexBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW
    )
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    this.vertexBuffer = vertexBuffer
  }

  compileShader(type, source) {
    const gl = this.gl
    const shader = gl.createShader(type)
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || 'Unable to compile shader.'
      gl.deleteShader(shader)
      throw new Error(message)
    }
    return shader
  }

  ensureOutputTarget(sourceWidth, sourceHeight) {
    const scale = Math.min(1, this.maxDimension / Math.max(sourceWidth, sourceHeight))
    const width = Math.max(24, Math.floor(sourceWidth * scale))
    const height = Math.max(18, Math.floor(sourceHeight * scale))

    if (width === this.outputWidth && height === this.outputHeight && this.framebuffer && this.outputTexture) {
      return
    }

    const gl = this.gl

    if (this.outputTexture) {
      gl.deleteTexture(this.outputTexture)
      this.outputTexture = null
    }
    if (this.framebuffer) {
      gl.deleteFramebuffer(this.framebuffer)
      this.framebuffer = null
    }

    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null
    )

    const framebuffer = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteTexture(texture)
      gl.deleteFramebuffer(framebuffer)
      throw new Error('Camera frame capture framebuffer is incomplete.')
    }

    this.outputTexture = texture
    this.framebuffer = framebuffer
    this.outputWidth = width
    this.outputHeight = height
  }

  captureFrame(frame, viewerPose) {
    if (!this.gl || !this.xrGlBinding || !frame || !viewerPose) {
      return null
    }

    if (this.inFlight) {
      this.skippedBusy += 1
      this.state = 'BACKPRESSURE'
      return null
    }

    const captureNow = performance.now()
    if (captureNow - this.lastCaptureAt < this.minFrameIntervalMs) {
      this.skippedThrottle += 1
      this.state = 'THROTTLED'
      return null
    }

    const view = viewerPose.views && viewerPose.views[0]
    if (!view || !view.camera) {
      this.state = 'NO_CAMERA'
      return null
    }

    if (typeof this.xrGlBinding.getCameraImage !== 'function') {
      this.state = 'NO_CAMERA_ACCESS'
      return null
    }

    const cameraTexture = this.xrGlBinding.getCameraImage(view.camera)
    if (!cameraTexture) {
      this.state = 'NO_CAMERA_IMAGE'
      return null
    }

    const sourceWidth = Number(view.camera.width || 0)
    const sourceHeight = Number(view.camera.height || 0)
    if (!sourceWidth || !sourceHeight) {
      this.state = 'NO_CAMERA_SIZE'
      return null
    }

    this.ensureOutputTarget(sourceWidth, sourceHeight)

    const gl = this.gl
    const startedAt = performance.now()
    const pixels = new Uint8Array(this.outputWidth * this.outputHeight * 4)
    const previousViewport = gl.getParameter(gl.VIEWPORT)
    const previousFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING)
    const previousArrayBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING)
    const previousTexture = gl.getParameter(gl.TEXTURE_BINDING_2D)
    const previousProgram = gl.getParameter(gl.CURRENT_PROGRAM)

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
    gl.viewport(0, 0, this.outputWidth, this.outputHeight)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
    gl.disable(gl.CULL_FACE)

    gl.useProgram(this.program)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer)
    gl.enableVertexAttribArray(this.positionLocation)
    gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, cameraTexture)
    gl.uniform1i(this.textureLocation, 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.readPixels(0, 0, this.outputWidth, this.outputHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels)

    gl.disableVertexAttribArray(this.positionLocation)
    gl.bindTexture(gl.TEXTURE_2D, previousTexture)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindBuffer(gl.ARRAY_BUFFER, previousArrayBuffer)
    gl.useProgram(previousProgram)
    gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer)
    gl.viewport(previousViewport[0], previousViewport[1], previousViewport[2], previousViewport[3])
    if (this.renderer && typeof this.renderer.resetState === 'function') {
      this.renderer.resetState()
    }

    this.lastCaptureAt = captureNow
    this.captures += 1
    this.lastCaptureMs = Number((performance.now() - startedAt).toFixed(3))
    this.averageCaptureMs = this.averageCaptureMs
      ? Number((this.averageCaptureMs * 0.82 + this.lastCaptureMs * 0.18).toFixed(3))
      : this.lastCaptureMs
    this.state = 'CAPTURING'

    return {
      width: this.outputWidth,
      height: this.outputHeight,
      sourceWidth: sourceWidth,
      sourceHeight: sourceHeight,
      pixels: pixels.buffer,
      captureMs: this.lastCaptureMs,
      timestampMs: captureNow,
      captures: this.captures,
      state: this.state,
    }
  }

  markFrameSubmitted() {
    this.inFlight = true
    this.state = 'IN_FLIGHT'
  }

  markFrameComplete() {
    this.inFlight = false
    this.state = this.session ? 'READY' : 'IDLE'
  }

  getDiagnostics() {
    return {
      state: this.state,
      maxDimension: this.maxDimension,
      minFrameIntervalMs: this.minFrameIntervalMs,
      captures: this.captures,
      skippedThrottle: this.skippedThrottle,
      skippedBusy: this.skippedBusy,
      lastCaptureMs: this.lastCaptureMs,
      averageCaptureMs: this.averageCaptureMs,
      inFlight: this.inFlight,
      outputWidth: this.outputWidth,
      outputHeight: this.outputHeight,
    }
  }
}

window.XRCameraFramePipeline = XRCameraFramePipeline
