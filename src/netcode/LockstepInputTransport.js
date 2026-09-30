const CTRL_PREFIX = 'wwlockstep:'
function encodeCtrl(obj) { return CTRL_PREFIX + JSON.stringify(obj) }
function decodeCtrl(data) {
  if (typeof data !== 'string' || !data.startsWith(CTRL_PREFIX)) return null
  try { return JSON.parse(data.slice(CTRL_PREFIX.length)) } catch { return null }
}

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
    const msg = decodeCtrl(detail?.data)
    if (!msg) return
    const from = detail.peerPubkey
    if (!from || from === this.myPubkey) return
    if (msg.type === 'input') {
      if (!Number.isInteger(msg.tick) || msg.tick < 1) { this.stats.malformed++; return }
      this.stats.received++
      if (this.onRemoteInput) this.onRemoteInput(from, msg.tick, msg.input ?? null, Number.isFinite(msg.adv) ? msg.adv : 0)
      return
    }
    if (msg.type === 'drop') {
      if (typeof msg.peer !== 'string' || !Number.isInteger(msg.have) || !Array.isArray(msg.tail)) { this.stats.malformed++; return }
      this.stats.dropReportsReceived++
      if (this.onRemoteDrop) this.onRemoteDrop(from, msg.peer, msg.have, msg.tail)
    }
  }

  getStats() { return { ...this.stats } }

  destroy() {
    this.bridge.data.removeEventListener('data', this._onData)
    this.bridge.data.removeEventListener('peer-close', this._onPeerClose)
    this.bridge.data.removeEventListener('peer-closed', this._onPeerClose)
  }
}

export const createLockstepInputTransport = (opts) => new LockstepInputTransport(opts)
