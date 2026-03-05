/**
 * Camera Module
 * Single Responsibility: Handle camera stream acquisition and management
 */

class CameraManager {
  constructor() {
    this.stream = null
    this.track = null
    this.videoElement = null
    this.facingMode = 'environment'
    this.constraints = {
      video: {
        facingMode: this.facingMode,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 60 },
      },
      audio: false,
    }
  }

  setVideoElement(videoElement) {
    this.videoElement = videoElement
  }

  async start() {
    if (!this.videoElement) {
      throw new Error('Video element not set')
    }

    this.stop()

    this.stream = await navigator.mediaDevices.getUserMedia(this.constraints)
    this.track = this.stream.getVideoTracks()[0] || null
    this.videoElement.srcObject = this.stream

    await new Promise((resolve, reject) => {
      const onLoadedMetadata = () => {
        this.videoElement
          .play()
          .then(resolve)
          .catch(reject)
      }

      this.videoElement.addEventListener('loadedmetadata', onLoadedMetadata, {
        once: true,
      })
    })

    return this.stream
  }

  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop())
    }
    this.stream = null
    this.track = null
    if (this.videoElement) {
      this.videoElement.srcObject = null
    }
  }

  async switchCamera() {
    this.facingMode = this.facingMode === 'environment' ? 'user' : 'environment'
    this.constraints.video.facingMode = this.facingMode
    return this.start()
  }

  async hasMultipleCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      return devices.filter((device) => device.kind === 'videoinput').length > 1
    } catch {
      return false
    }
  }

  getDimensions() {
    if (!this.videoElement) {
      return { width: 0, height: 0 }
    }
    return {
      width: this.videoElement.videoWidth,
      height: this.videoElement.videoHeight,
    }
  }

  getActiveTrack() {
    return this.track
  }

  getTrackSettings() {
    return this.track && this.track.getSettings ? this.track.getSettings() : {}
  }

  getTrackCapabilities() {
    return this.track && this.track.getCapabilities ? this.track.getCapabilities() : {}
  }

  captureFrame(canvas) {
    if (!this.videoElement || !this.stream) {
      return null
    }

    const { width, height } = this.getDimensions()
    canvas.width = width
    canvas.height = height

    const ctx = canvas.getContext('2d')
    ctx.drawImage(this.videoElement, 0, 0, width, height)

    return canvas
  }

  getFrameAsBase64(quality = 0.7) {
    if (!this.videoElement || !this.stream) {
      return null
    }

    const canvas = document.createElement('canvas')
    this.captureFrame(canvas)
    return canvas.toDataURL('image/jpeg', quality)
  }

  isActive() {
    return this.stream !== null && this.stream.active
  }
}

window.CameraManager = CameraManager
