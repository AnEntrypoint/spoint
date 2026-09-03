import { pack } from '../protocol/msgpack.js'
import { MSG } from '../protocol/MessageTypes.js'
const _isNode = typeof process !== 'undefined' && process.versions?.node
const { createMachine, createActor, assign } = await import(_isNode ? 'xstate' : '/node_modules/xstate/dist/xstate.esm.js')

const machine = createMachine({
  id: 'reconn',
  initial: 'idle',
  context: { attempts: 0 },
  states: {
    idle: { on: { CONNECT: 'connected' } },
    connected: {
      entry: assign({ attempts: 0 }),
      on: { DISCONNECT: 'waiting', DESTROY: 'destroyed' }
    },
    waiting: {
      entry: assign({ attempts: ({ context }) => context.attempts + 1 }),
      on: { RETRY: 'reconnecting', DESTROY: 'destroyed' }
    },
    reconnecting: { on: { CONNECTED: 'connected', DISCONNECT: 'waiting', DESTROY: 'destroyed' } },
    destroyed: { type: 'final' }
  }
})

export class ReconnectManager {
  constructor(config = {}) {
    this._maxDelay = config.maxReconnectDelay || 5000
    this._timer = null
    this._token = null
    this._actor = createActor(machine)
    this._actor.start()
  }
  get _attempts() { return this._actor.getSnapshot().context.attempts }
  get _state() { return this._actor.getSnapshot().value }
  setSessionToken(token) { this._token = token }
  isReconnecting() { return this._state === 'waiting' || this._state === 'reconnecting' }
  sendReconnectMessage(ws) {
    // TOCTOU: socket can close between the readyState check and send; swallow the throw, the reconnect machine retries
    if (this._token && this.isReconnecting() && ws?.readyState === WebSocket.OPEN) {
      try { ws.send(pack({ type: MSG.RECONNECT, payload: { sessionToken: this._token } })) }
      catch (e) { console.error('[reconnect] send failed:', e?.message || e) }
    }
  }
  onConnected() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    const s = this._state
    if (s === 'reconnecting') this._actor.send({ type: 'CONNECTED' })
    else if (s === 'idle') this._actor.send({ type: 'CONNECT' })
  }
  onDisconnected(callback) {
    if (this._state === 'destroyed') return
    if (this._timer) return
    this._actor.send({ type: 'DISCONNECT' })
    const delay = Math.min(1000 * Math.pow(1.5, this._attempts - 1), this._maxDelay)
    this._timer = setTimeout(() => {
      this._timer = null
      if (this._state !== 'destroyed') {
        this._actor.send({ type: 'RETRY' })
        callback()
      }
    }, delay)
  }
  clear() {
    this._actor.send({ type: 'DESTROY' })
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    this._token = null
    this._actor.stop()
  }
  invalidateSession() {
    this._token = null
    if (this._state === 'waiting' || this._state === 'reconnecting') {
      if (this._timer) { clearTimeout(this._timer); this._timer = null }
    }
  }
}
