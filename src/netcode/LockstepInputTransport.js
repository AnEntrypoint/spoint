import { LOCKSTEP_CTRL_PREFIX, controlFrameHandlers, countOrder, countReject, createFrameClock, dispatchControlFrame, encodeControlFrame } from './controlFrame.js'

function encodeCtrl(obj) { return encodeControlFrame(LOCKSTEP_CTRL_PREFIX, obj) }

export class LockstepInputTransport {
  constructor({ bridge, onRemoteInput = null, onRemoteDrop = null, onPeerClosed = null } = {}) {
    if (!bridge?.data) throw new Error('LockstepInputTransport: bridge.data required')
    this.bridge = bridge
    this.onRemoteInput = onRemoteInput
    this.onRemoteDrop = onRemoteDrop
    this.onPeerClosed = onPeerClosed
    this._clock = createFrameClock()
    this._onData = ({ detail }) => this._handleFrame(detail)
    this._onPeerClose = ({ detail }) => { if (detail?.peerPubkey && this.onPeerClosed) this.onPeerClosed(detail.peerPubkey) }
    bridge.data.addEventListener('data', this._onData)
    bridge.data.addEventListener('peer-close', this._onPeerClose)
    bridge.data.addEventListener('peer-closed', this._onPeerClose)
    this.stats = { sent: 0, received: 0, unknownKind: 0, dropReportsSent: 0, dropReportsReceived: 0, rejects: {} }
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
    const dispatched = dispatchControlFrame(LOCKSTEP_CTRL_PREFIX, this._arms, detail?.data, countReject(this.stats), {
      from: detail?.peerPubkey,
      selfId: this.myPubkey,
      clock: this._clock,
      tickOf: (frame) => frame.tick,
      onOrder: countOrder(this.stats),
    })
    if (!dispatched) return
    dispatched.apply(dispatched.frame, dispatched.from)
  }

  _applyRemoteInput(frame, from) {
    this.stats.received++
    if (this.onRemoteInput) this.onRemoteInput(from, frame.tick, frame.input ?? null, Number.isFinite(frame.adv) ? frame.adv : 0)
  }

  _applyRemoteDrop(frame, from) {
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
