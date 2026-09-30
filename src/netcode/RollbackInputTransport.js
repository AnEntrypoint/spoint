const CTRL_PREFIX = 'wwrollback:'
function encodeCtrl(obj) { return CTRL_PREFIX + JSON.stringify(obj) }
function decodeCtrl(data) {
  if (typeof data !== 'string' || !data.startsWith(CTRL_PREFIX)) return null
  try { return JSON.parse(data.slice(CTRL_PREFIX.length)) } catch { return null }
}

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
    this._lastTickByPeer = new Map()

    this._onData = ({ detail }) => this._handleFrame(detail)
    this._onPeerOpen = ({ detail }) => { if (detail?.peerPubkey) this._roster.add(detail.peerPubkey) }
    this._onPeerClose = ({ detail }) => { if (detail?.peerPubkey) this.dropPeer(detail.peerPubkey) }
    bridge.data.addEventListener('data', this._onData)
    bridge.data.addEventListener('peer-open', this._onPeerOpen)
    bridge.data.addEventListener('peer-close', this._onPeerClose)
    bridge.data.addEventListener('peer-closed', this._onPeerClose)
    for (const [pk, peer] of bridge.data.peers) if (peer?.dc?.readyState === 'open') this._roster.add(pk)

    this.stats = { sent: 0, received: 0, staleIgnored: 0, checksumsSent: 0, checksumsReceived: 0 }
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
    const msg = decodeCtrl(detail?.data)
    if (!msg || typeof msg.tick !== 'number') return
    const from = detail.peerPubkey
    if (!from || from === this.myPubkey) return
    if (msg.type === 'checksum') {
      this.stats.checksumsReceived++
      if (this.onRemoteChecksum) this.onRemoteChecksum(from, msg.tick, msg.checksum)
      return
    }
    if (msg.type !== 'input') return
    this._roster.add(from)
    this._dropped.delete(from)
    const last = this._lastTickByPeer.get(from) ?? -1
    if (msg.tick < last) this.stats.staleIgnored++
    if (msg.tick > last) this._lastTickByPeer.set(from, msg.tick)
    this.stats.received++
    if (this.onRemoteInput) this.onRemoteInput(from, msg.tick, msg.input, Number.isFinite(msg.adv) ? msg.adv : 0)
  }

  dropPeer(pubkey) {
    if (!pubkey) return
    this._dropped.add(pubkey)
  }

  getStalledPeers(nowTick) {
    const out = []
    for (const pk of this._roster) {
      if (this._dropped.has(pk)) continue
      const last = this._lastTickByPeer.get(pk)
      if (last === undefined || nowTick - last > this.stallTicks) out.push({ pubkey: pk, lastTick: last ?? -1 })
    }
    return out
  }

  getRoster() { return [...this._roster].filter(pk => !this._dropped.has(pk)) }

  getStats() {
    return { ...this.stats, roster: [...this._roster], dropped: [...this._dropped], lastTickByPeer: Object.fromEntries(this._lastTickByPeer) }
  }

  destroy() {
    this.bridge.data.removeEventListener('data', this._onData)
    this.bridge.data.removeEventListener('peer-open', this._onPeerOpen)
    this.bridge.data.removeEventListener('peer-close', this._onPeerClose)
    this.bridge.data.removeEventListener('peer-closed', this._onPeerClose)
  }
}

export const createRollbackInputTransport = (opts) => new RollbackInputTransport(opts)
