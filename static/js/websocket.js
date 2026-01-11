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

        // Event callbacks
        this.onConnectCallback = null
        this.onDisconnectCallback = null
        this.onResultCallback = null
        this.onStatusCallback = null
        this.onErrorCallback = null
    }

    /**
     * Connect to WebSocket server
     * @returns {Promise<void>}
     */
    connect() {
        return new Promise((resolve, reject) => {
            try {
                // Use Socket.IO client
                this.socket = io({
                    transports: ['websocket', 'polling'],
                    reconnection: true,
                    reconnectionAttempts: this.maxReconnectAttempts,
                    reconnectionDelay: this.reconnectDelay
                })

                // Connection handlers
                this.socket.on('connect', () => {
                    console.log('WebSocket connected')
                    this.isConnected = true
                    this.reconnectAttempts = 0
                    if (this.onConnectCallback) {
                        this.onConnectCallback()
                    }
                    resolve()
                })

                this.socket.on('disconnect', (reason) => {
                    console.log('WebSocket disconnected:', reason)
                    this.isConnected = false
                    if (this.onDisconnectCallback) {
                        this.onDisconnectCallback(reason)
                    }
                })

                this.socket.on('connect_error', (error) => {
                    console.error('WebSocket connection error:', error)
                    this.reconnectAttempts++
                    if (this.onErrorCallback) {
                        this.onErrorCallback(error)
                    }
                    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                        reject(new Error('Max reconnection attempts reached'))
                    }
                })

                // Custom event handlers
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

            } catch (error) {
                console.error('WebSocket initialization error:', error)
                reject(error)
            }
        })
    }

    /**
     * Disconnect from server
     */
    disconnect() {
        if (this.socket) {
            this.socket.disconnect()
            this.socket = null
        }
        this.isConnected = false
    }

    /**
     * Send video frame to server
     * @param {string} frameData - Base64 encoded frame
     */
    sendFrame(frameData) {
        if (!this.isConnected || !this.socket) {
            return false
        }
        this.socket.emit('frame', frameData)
        return true
    }

    /**
     * Send video frame with camera intrinsics to server
     * @param {string} frameData - Base64 encoded frame
     * @param {Object} intrinsics - Camera intrinsics {fx, fy, cx, cy, width, height, fov}
     */
    sendFrameWithIntrinsics(frameData, intrinsics, frameId = null) {
        if (!this.isConnected || !this.socket) {
            return false
        }
        this.socket.emit('frame', {
            image: frameData,
            intrinsics: intrinsics,
            id: frameId
        })
        return true
    }

    /**
     * Set callback for connection event
     * @param {Function} callback
     */
    onConnect(callback) {
        this.onConnectCallback = callback
    }

    /**
     * Set callback for disconnection event
     * @param {Function} callback
     */
    onDisconnect(callback) {
        this.onDisconnectCallback = callback
    }

    /**
     * Set callback for result event
     * @param {Function} callback
     */
    onResult(callback) {
        this.onResultCallback = callback
    }

    /**
     * Set callback for status event
     * @param {Function} callback
     */
    onStatus(callback) {
        this.onStatusCallback = callback
    }

    /**
     * Set callback for error event
     * @param {Function} callback
     */
    onError(callback) {
        this.onErrorCallback = callback
    }

    /**
     * Check connection status
     * @returns {boolean}
     */
    isReady() {
        return this.isConnected && this.socket !== null
    }
}

// Export singleton instance
window.WebSocketManager = WebSocketManager
