import { LOCKSTEP_CTRL_PREFIX, controlFrameHandlers, dispatchControlFrame, encodeControlFrame } from './controlFrame.js'

function encodeCtrl(obj) { return encodeControlFrame(LOCKSTEP_CTRL_PREFIX, obj) }

export class LockstepInputTransport {
  constructor({ bridge, onRemoteInput = null, onRemoteDrop = null, onPeerClosed = null } = {}) {
    if (!bridge?.data) throw new Error('LockstepInputTransport: bridge.data required')
    this.bridge = bridge
    this.onRemoteInput = onRemoteInput
    this.onRemoteDrop = onRemoteDrop
    this.onPeerClosed = onPeerClosed
    this._onData = ({ detail }) => this._handleFrame(detail)
    this._onPeerClose = ({ detail }) => { if (detail?.peerPubkey && this.onPeerClosed) this.onPeerClosed(detail.peerPubkey) }
    bridge.data.addEventListener('data', this._onData)
    bridge.data.addEventListener('peer-close', this._onPeerClose)
    bridge.data.addEventListener('peer-closed', this._onPeerClose)
    this.stats = { sent: 0, received: 0, malformed: 0, dropReportsSent: 0, dropReportsReceived: 0 }
    this._arms = controlFrameHandlers(LOCKSTEP_CTRL_PREFIX, {
      input: (frame, from) => this._applyRemoteInput(frame, from),
      drop: (frame, from) => this._applyRemoteDrop(frame, from),
    })
  }

  get myPubkey() { return this.bridge.pubkey }

  submitLocalInput(tick, input, advantage = 0) {
    if (!this.myPubkey) throw new Error('LockstepInputTransport: bridge not connected (no pubkey yet)')
    this.bridge.data.broadcast(encodeCtrl({ type: 'input', tick, input, adv: advantage }))
    this.stats.sent++
  }

  submitDropReport(peer, have, tail) {
    this.bridge.data.broadcast(encodeCtrl({ type: 'drop', peer, have, tail }))
    this.stats.dropReportsSent++
  }

  _handleFrame(detail) {
    const dispatched = dispatchControlFrame(LOCKSTEP_CTRL_PREFIX, this._arms, detail?.data)
    if (!dispatched) return
    const from = detail.peerPubkey
    if (!from || from === this.myPubkey) return
    dispatched.apply(dispatched.frame, from)
  }

  _applyRemoteInput(frame, from) {
    if (!Number.isInteger(frame.tick) || frame.tick < 1) { this.stats.malformed++; return }
    this.stats.received++
    if (this.onRemoteInput) this.onRemoteInput(from, frame.tick, frame.input ?? null, Number.isFinite(frame.adv) ? frame.adv : 0)
  }

  _applyRemoteDrop(frame, from) {
    if (typeof frame.peer !== 'string' || !Number.isInteger(frame.have) || !Array.isArray(frame.tail)) { this.stats.malformed++; return }
    this.stats.dropReportsReceived++
    if (this.onRemoteDrop) this.onRemoteDrop(from, frame.peer, frame.have, frame.tail)
  }

  getStats() { return { ...this.stats } }

  destroy() {
    this.bridge.data.removeEventListener('data', this._onData)
    this.bridge.data.removeEventListener('peer-close', this._onPeerClose)
    this.bridge.data.removeEventListener('peer-closed', this._onPeerClose)
  }
}

export const createLockstepInputTransport = (opts) => new LockstepInputTransport(opts)
