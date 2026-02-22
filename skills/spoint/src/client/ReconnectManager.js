import { pack } from '../protocol/msgpack.js'
import { MSG } from '../protocol/MessageTypes.js'

export class ReconnectManager {
  constructor(config = {}) {
    this._sessionToken = null
    this._reconnectAttempts = 0
    this._reconnectTimer = null
    this._reconnecting = false
    this._maxReconnectDelay = config.maxReconnectDelay || 5000
    this._destroyed = false
  }

  setSessionToken(token) {
    this._sessionToken = token
  }

  isReconnecting() {
    return this._reconnecting
  }

  sendReconnectMessage(ws) {
    if (this._sessionToken && this._reconnecting && ws?.readyState === WebSocket.OPEN) {
      ws.send(pack({ type: MSG.RECONNECT, payload: { sessionToken: this._sessionToken } }))
    }
  }

  onConnected() {
    this._reconnectAttempts = 0
    this._reconnecting = false
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
  }

  onDisconnected(callback) {
    if (this._destroyed) return
    if (this._reconnectTimer) return
    const delay = Math.min(1000 * Math.pow(1.5, this._reconnectAttempts), this._maxReconnectDelay)
    this._reconnectAttempts++
    this._reconnecting = true
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      if (!this._destroyed) callback()
    }, delay)
  }

  clear() {
    this._destroyed = true
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
    this._sessionToken = null
  }

  invalidateSession() {
    this._sessionToken = null
    this._reconnecting = false
  }
}
