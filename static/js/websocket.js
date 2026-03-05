/**
 * WebSocket Module
 * Single Responsibility: Handle WebSocket communication with server
 */

class WebSocketManager {
  constructor(url = null) {
    this.socket = null
    this.url = url
    this.isConnected = false
    this.reconnectAttempts = 0
    this.maxReconnectAttempts = 5
    this.reconnectDelay = 1000

    this.onConnectCallback = null
    this.onDisconnectCallback = null
    this.onResultCallback = null
    this.onStatusCallback = null
    this.onErrorCallback = null
  }

  connect() {
    return new Promise((resolve, reject) => {
      try {
        this.socket = this.url
          ? io(this.url, {
              transports: ['websocket', 'polling'],
              reconnection: true,
              reconnectionAttempts: this.maxReconnectAttempts,
              reconnectionDelay: this.reconnectDelay,
            })
          : io({
              transports: ['websocket', 'polling'],
              reconnection: true,
              reconnectionAttempts: this.maxReconnectAttempts,
              reconnectionDelay: this.reconnectDelay,
            })

        this.socket.on('connect', () => {
          this.isConnected = true
          this.reconnectAttempts = 0
          if (this.onConnectCallback) {
            this.onConnectCallback()
          }
          resolve()
        })

        this.socket.on('disconnect', (reason) => {
          this.isConnected = false
          if (this.onDisconnectCallback) {
            this.onDisconnectCallback(reason)
          }
        })

        this.socket.on('connect_error', (error) => {
          this.reconnectAttempts += 1
          if (this.onErrorCallback) {
            this.onErrorCallback(error)
          }
          if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            reject(new Error('Max reconnection attempts reached'))
          }
        })

        this.socket.on('status', (data) => {
          if (this.onStatusCallback) {
            this.onStatusCallback(data)
          }
        })

        this.socket.on('result', (data) => {
          if (this.onResultCallback) {
            this.onResultCallback(data)
          }
        })

        this.socket.on('error', (data) => {
          if (this.onErrorCallback) {
            this.onErrorCallback(data)
          }
        })
      } catch (error) {
        reject(error)
      }
    })
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect()
      this.socket = null
    }
    this.isConnected = false
  }

  sendFrame(frameData) {
    if (!this.isConnected || !this.socket) {
      return false
    }
    this.socket.emit('frame', frameData)
    return true
  }

  sendFrameWithIntrinsics(frameData, intrinsics, frameId = null) {
    if (!this.isConnected || !this.socket) {
      return false
    }
    this.socket.emit('frame', {
      image: frameData,
      intrinsics: intrinsics,
      id: frameId,
    })
    return true
  }

  onConnect(callback) {
    this.onConnectCallback = callback
  }

  onDisconnect(callback) {
    this.onDisconnectCallback = callback
  }

  onResult(callback) {
    this.onResultCallback = callback
  }

  onStatus(callback) {
    this.onStatusCallback = callback
  }

  onError(callback) {
    this.onErrorCallback = callback
  }

  isReady() {
    return this.isConnected && this.socket !== null
  }
}

window.WebSocketManager = WebSocketManager
