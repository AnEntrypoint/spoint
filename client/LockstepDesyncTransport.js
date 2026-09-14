const CTRL_PREFIX = 'wwdesync:'
function encodeCtrl(obj) { return CTRL_PREFIX + JSON.stringify(obj) }
function decodeCtrl(data) {
  if (typeof data !== 'string' || !data.startsWith(CTRL_PREFIX)) return null
  try { return JSON.parse(data.slice(CTRL_PREFIX.length)) } catch { return null }
}

function snapToWire(snap) { return [...snap.entries()] }
function snapFromWire(pairs) { return new Map(pairs) }

export class LockstepDesyncTransport {
  constructor({ bridge, detector, physics, onPause = null, onResume = null } = {}) {
    if (!bridge?.data) throw new Error('LockstepDesyncTransport: bridge.data required')
    if (!detector) throw new Error('LockstepDesyncTransport: detector (DesyncDetector instance) required')
    if (!physics || typeof physics.snapshotBodies !== 'function') throw new Error('LockstepDesyncTransport: physics (PhysicsWorld exposing snapshotBodies/restoreBodies) required')
    this.bridge = bridge
    this.detector = detector
    this.physics = physics
    this.onPause = onPause
    this.onResume = onResume
    this.recovering = false
    this._pendingSnapshotRequests = new Map()

    this._onData = ({ detail }) => this._handleFrame(detail)
    bridge.data.addEventListener('data', this._onData)

    const priorOnDesync = detector.onDesync
    detector.onDesync = (tick, result) => {
      if (priorOnDesync) { try { priorOnDesync(tick, result) } catch (e) { console.error('[LockstepDesyncTransport] prior onDesync threw:', e?.message || e) } }
      this._handleDesync(tick, result).catch(e => console.error('[LockstepDesyncTransport] recovery failed:', e?.message || e))
    }
  }

  get myPubkey() { return this.bridge.pubkey }

  reportLocalChecksum(tick, checksum) {
    const me = this.myPubkey
    if (!me) throw new Error('LockstepDesyncTransport: bridge not connected (no pubkey yet)')
    this.bridge.data.broadcast(encodeCtrl({ type: 'checksum', tick, checksum }))
    return this.detector.reportChecksum(tick, me, checksum)
  }

  _handleFrame(detail) {
    const msg = decodeCtrl(detail?.data)
    if (!msg) return
    const from = detail.peerPubkey
    if (!from || from === this.myPubkey) return
    if (msg.type === 'checksum' && typeof msg.tick === 'number' && typeof msg.checksum === 'string') {
      this.detector.reportChecksum(msg.tick, from, msg.checksum)
    } else if (msg.type === 'snapshot-request' && msg.forPeer === this.myPubkey) {
      const snap = this.physics.snapshotBodies()
      this.bridge.data.send(from, encodeCtrl({ type: 'snapshot-response', tick: msg.tick, snap: snapToWire(snap) }))
    } else if (msg.type === 'snapshot-response' && typeof msg.tick === 'number') {
      const resolver = this._pendingSnapshotRequests.get(msg.tick)
      if (resolver) { this._pendingSnapshotRequests.delete(msg.tick); resolver(snapFromWire(msg.snap)) }
    }
  }

  _pickAuthoritativePeer(result) {
    const majority = []
    for (const [pk, cs] of result.reports) if (cs === result.majorityChecksum) majority.push(pk)
    majority.sort()
    return majority[0] || null
  }

  async _handleDesync(tick, result) {
    const me = this.myPubkey
    const myChecksum = result.reports.get(me)
    if (myChecksum === result.majorityChecksum) return
    const authority = this._pickAuthoritativePeer(result)
    if (!authority || authority === me) {
      console.error(`[LockstepDesyncTransport] desync at tick ${tick} but no authoritative peer resolvable (offenders: ${result.offenders.join(',')})`)
      return
    }
    this.recovering = true
    if (this.onPause) { try { this.onPause(tick, result) } catch (_) {} }
    try {
      const snap = await this._requestSnapshotFrom(authority, tick)
      this.physics.restoreBodies(snap)
    } finally {
      this.recovering = false
      if (this.onResume) { try { this.onResume(tick, result) } catch (_) {} }
    }
  }

  _requestSnapshotFrom(authority, tick) {
    return new Promise((resolve) => {
      this._pendingSnapshotRequests.set(tick, resolve)
      this.bridge.data.send(authority, encodeCtrl({ type: 'snapshot-request', tick, forPeer: authority }))
    })
  }

  destroy() {
    this.bridge.data.removeEventListener('data', this._onData)
    this._pendingSnapshotRequests.clear()
  }
}

export const createLockstepDesyncTransport = (opts) => new LockstepDesyncTransport(opts)

export const _test = { CTRL_PREFIX, encodeCtrl, decodeCtrl, snapToWire, snapFromWire }
