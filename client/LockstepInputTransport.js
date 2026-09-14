const CTRL_PREFIX = 'wwlockstep:'
function encodeCtrl(obj) { return CTRL_PREFIX + JSON.stringify(obj) }
function decodeCtrl(data) {
  if (typeof data !== 'string' || !data.startsWith(CTRL_PREFIX)) return null
  try { return JSON.parse(data.slice(CTRL_PREFIX.length)) } catch { return null }
}

const DEFAULT_INPUT_DELAY_TICKS = 2

const DEFAULT_STALL_TICKS = 180

export class LockstepInputTransport {
  constructor({ bridge, inputDelayTicks = DEFAULT_INPUT_DELAY_TICKS, stallTicks = DEFAULT_STALL_TICKS } = {}) {
    if (!bridge?.data) throw new Error('LockstepInputTransport: bridge.data required')
    this.bridge = bridge
    this.inputDelayTicks = inputDelayTicks
    this.stallTicks = stallTicks

    this._byTick = new Map()
    this._lastTickByPeer = new Map()
    this._roster = new Set()
    this._dropped = new Set()
    this._waiters = new Map()

    this._onData = ({ detail }) => this._handleFrame(detail)
    this._onPeerOpen = ({ detail }) => { if (detail?.peerPubkey) this._roster.add(detail.peerPubkey) }
    this._onPeerClose = ({ detail }) => { if (detail?.peerPubkey) this.dropPeer(detail.peerPubkey) }
    bridge.data.addEventListener('data', this._onData)
    bridge.data.addEventListener('peer-open', this._onPeerOpen)
    bridge.data.addEventListener('peer-close', this._onPeerClose)
    bridge.data.addEventListener('peer-closed', this._onPeerClose)
    for (const [pk, peer] of bridge.data.peers) if (peer?.dc?.readyState === 'open') this._roster.add(pk)

    this.stats = { sent: 0, received: 0, duplicatesIgnored: 0, staleIgnored: 0, ticksReady: 0 }
  }

  get myPubkey() { return this.bridge.pubkey }

  targetTickFor(localTick) { return localTick + this.inputDelayTicks }

  submitLocalInput(tick, input) {
    const me = this.myPubkey
    if (!me) throw new Error('LockstepInputTransport: bridge not connected (no pubkey yet)')
    this._record(tick, me, input)
    const n = this.bridge.data.broadcast(encodeCtrl({ type: 'input', tick, input }))
    this.stats.sent++
    return n
  }

  _handleFrame(detail) {
    const msg = decodeCtrl(detail?.data)
    if (!msg || msg.type !== 'input' || typeof msg.tick !== 'number') return
    const from = detail.peerPubkey
    if (!from || from === this.myPubkey) return
    this._roster.add(from)
    this._dropped.delete(from)
    this._record(tick_from(msg), from, msg.input)
  }

  _record(tick, pubkey, input) {
    let m = this._byTick.get(tick)
    if (!m) { m = new Map(); this._byTick.set(tick, m) }
    if (m.has(pubkey)) { this.stats.duplicatesIgnored++; return }
    m.set(pubkey, input)
    this.stats.received++
    const last = this._lastTickByPeer.get(pubkey) || -1
    if (tick > last) this._lastTickByPeer.set(pubkey, tick)
    this._maybeResolve(tick)
  }

  isTickReady(tick) {
    const m = this._byTick.get(tick)
    if (!m) return false
    for (const pk of this._roster) {
      if (this._dropped.has(pk)) continue
      if (!m.has(pk)) return false
    }
    return true
  }

  getTickInputs(tick) {
    const m = this._byTick.get(tick)
    return m ? Object.fromEntries(m) : null
  }

  waitForTick(tick) {
    if (this.isTickReady(tick)) return Promise.resolve(this.getTickInputs(tick))
    return new Promise((resolve) => {
      let arr = this._waiters.get(tick)
      if (!arr) { arr = []; this._waiters.set(tick, arr) }
      arr.push(resolve)
    })
  }

  _maybeResolve(tick) {
    if (!this.isTickReady(tick)) return
    const arr = this._waiters.get(tick)
    if (!arr) return
    this._waiters.delete(tick)
    this.stats.ticksReady++
    const payload = this.getTickInputs(tick)
    for (const r of arr) r(payload)
  }

  dropPeer(pubkey) {
    if (!pubkey || this._dropped.has(pubkey)) return
    this._dropped.add(pubkey)
    for (const tick of this._waiters.keys()) this._maybeResolve(tick)
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

  pruneBefore(beforeTick) {
    for (const tick of this._byTick.keys()) if (tick < beforeTick) this._byTick.delete(tick)
    for (const tick of this._waiters.keys()) if (tick < beforeTick) this._waiters.delete(tick)
  }

  getStats() {
    return {
      ...this.stats,
      roster: [...this._roster],
      dropped: [...this._dropped],
      pendingTicks: [...this._byTick.keys()].sort((a, b) => a - b),
      pendingWaiters: [...this._waiters.keys()].sort((a, b) => a - b)
    }
  }

  destroy() {
    this.bridge.data.removeEventListener('data', this._onData)
    this.bridge.data.removeEventListener('peer-open', this._onPeerOpen)
    this.bridge.data.removeEventListener('peer-close', this._onPeerClose)
    this.bridge.data.removeEventListener('peer-closed', this._onPeerClose)
    for (const arr of this._waiters.values()) for (const r of arr) r(null)
    this._waiters.clear()
  }
}

function tick_from(msg) { return msg.tick }

export const createLockstepInputTransport = (opts) => new LockstepInputTransport(opts)

export const _test = { CTRL_PREFIX, encodeCtrl, decodeCtrl, DEFAULT_INPUT_DELAY_TICKS, DEFAULT_STALL_TICKS }
