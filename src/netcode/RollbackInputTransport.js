import { ROLLBACK_CTRL_PREFIX, controlFrameHandlers, countOrder, countReject, createFrameClock, dispatchControlFrame, encodeControlFrame } from './controlFrame.js'

function encodeCtrl(obj) { return encodeControlFrame(ROLLBACK_CTRL_PREFIX, obj) }

const DEFAULT_STALL_TICKS = 180

export class RollbackInputTransport {
  constructor({ bridge, stallTicks = DEFAULT_STALL_TICKS, onRemoteInput = null, onRemoteChecksum = null } = {}) {
    if (!bridge?.data) throw new Error('RollbackInputTransport: bridge.data required')
    this.bridge = bridge
    this.stallTicks = stallTicks
    this.onRemoteInput = onRemoteInput
    this.onRemoteChecksum = onRemoteChecksum

    this._roster = new Set()
    this._dropped = new Set()
    this._clock = createFrameClock()

    this._onData = ({ detail }) => this._handleFrame(detail)
    this._onPeerOpen = ({ detail }) => { if (detail?.peerPubkey) this._roster.add(detail.peerPubkey) }
    this._onPeerClose = ({ detail }) => { if (detail?.peerPubkey) this.dropPeer(detail.peerPubkey) }
    bridge.data.addEventListener('data', this._onData)
    bridge.data.addEventListener('peer-open', this._onPeerOpen)
    bridge.data.addEventListener('peer-close', this._onPeerClose)
    bridge.data.addEventListener('peer-closed', this._onPeerClose)
    for (const [pk, peer] of bridge.data.peers) if (peer?.dc?.readyState === 'open') this._roster.add(pk)

    this.stats = { sent: 0, received: 0, staleIgnored: 0, unknownKind: 0, checksumsSent: 0, checksumsReceived: 0, rejects: {} }
    this._arms = controlFrameHandlers(ROLLBACK_CTRL_PREFIX, {
      input: (frame, from) => this._applyRemoteInput(frame, from),
      checksum: (frame, from) => this._applyRemoteChecksum(frame, from),
    })
  }

  get myPubkey() { return this.bridge.pubkey }

  submitLocalInput(tick, input, advantage = 0) {
    if (!this.myPubkey) throw new Error('RollbackInputTransport: bridge not connected (no pubkey yet)')
    const n = this.bridge.data.broadcast(encodeCtrl({ type: 'input', tick, input, adv: advantage }))
    this.stats.sent++
    return n
  }

  submitChecksum(tick, checksum) {
    this.bridge.data.broadcast(encodeCtrl({ type: 'checksum', tick, checksum }))
    this.stats.checksumsSent++
  }

  _handleFrame(detail) {
    const dispatched = dispatchControlFrame(ROLLBACK_CTRL_PREFIX, this._arms, detail?.data, countReject(this.stats), {
      from: detail?.peerPubkey,
      selfId: this.myPubkey,
      clock: this._clock,
      tickOf: (frame) => (frame.type === 'input' ? frame.tick : undefined),
      onOrder: countOrder(this.stats),
    })
    if (!dispatched) return
    dispatched.apply(dispatched.frame, dispatched.from)
  }

  _applyRemoteChecksum(frame, from) {
    this.stats.checksumsReceived++
    if (this.onRemoteChecksum) this.onRemoteChecksum(from, frame.tick, frame.checksum)
  }

  _applyRemoteInput(frame, from) {
    this._roster.add(from)
    this._dropped.delete(from)
    this.stats.received++
    if (this.onRemoteInput) this.onRemoteInput(from, frame.tick, frame.input, Number.isFinite(frame.adv) ? frame.adv : 0)
  }

  dropPeer(pubkey) {
    if (!pubkey) return
    this._dropped.add(pubkey)
  }

  getStalledPeers(nowTick) {
    const out = []
    for (const pk of this._roster) {
      if (this._dropped.has(pk)) continue
      const last = this._clock.get(pk)
      if (last === undefined || nowTick - last > this.stallTicks) out.push({ pubkey: pk, lastTick: last ?? -1 })
    }
    return out
  }

  getRoster() { return [...this._roster].filter(pk => !this._dropped.has(pk)) }

  getStats() {
    return { ...this.stats, staleIgnored: this.stats.order?.['stale-frame'] ?? 0, duplicateIgnored: this.stats.order?.['duplicate-frame'] ?? 0, roster: [...this._roster], dropped: [...this._dropped], lastTickByPeer: Object.fromEntries(this._clock) }
  }

  destroy() {
    this.bridge.data.removeEventListener('data', this._onData)
    this.bridge.data.removeEventListener('peer-open', this._onPeerOpen)
    this.bridge.data.removeEventListener('peer-close', this._onPeerClose)
    this.bridge.data.removeEventListener('peer-closed', this._onPeerClose)
  }
}

export const createRollbackInputTransport = (opts) => new RollbackInputTransport(opts)
