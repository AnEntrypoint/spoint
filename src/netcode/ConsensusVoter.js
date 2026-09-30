import { DesyncDetector } from './DesyncDetector.js'

const CTRL_PREFIX = 'wwlockstep:'

function encodeChecksumMsg(tick, pubkey, checksum) {
  return CTRL_PREFIX + JSON.stringify({ type: 'checksum', tick, pubkey, checksum })
}

function decodeCtrl(data) {
  if (typeof data !== 'string' || !data.startsWith(CTRL_PREFIX)) return null
  try { return JSON.parse(data.slice(CTRL_PREFIX.length)) } catch { return null }
}

export const DEFAULT_CONSECUTIVE_DESYNCS_REQUIRED = 3
const DESYNC_LOG_LIMIT = 16
const REMOTE_CHECKSUM_PAST_HORIZON_ROWS = 16

export class ConsensusVoter {
  constructor({
    bridge,
    checksumOf,
    localPeerId,
    expectedPeerIds,
    hostPeerId = null,
    checksumIntervalTicks = 30,
    consecutiveDesyncsRequired = DEFAULT_CONSECUTIVE_DESYNCS_REQUIRED,
    onCheatingHost = null,
    onCheatingPeer = null,
    onEjectionReady = null,
  } = {}) {
    if (!bridge?.data) throw new Error('[ConsensusVoter] bridge (wireweave bridge or WorkerBridgeProxy) is required')
    if (typeof checksumOf !== 'function') throw new Error('[ConsensusVoter] checksumOf(tick) is required')
    if (!localPeerId) throw new Error('[ConsensusVoter] localPeerId is required')
    if (!Array.isArray(expectedPeerIds) || expectedPeerIds.length < 2) {
      throw new Error('[ConsensusVoter] expectedPeerIds must be an array of at least 2 peer pubkeys')
    }

    this.bridge = bridge
    this.checksumOf = checksumOf
    this.localPeerId = localPeerId
    this.hostPeerId = hostPeerId
    this.consecutiveDesyncsRequired = consecutiveDesyncsRequired
    this.onCheatingHost = onCheatingHost
    this.onCheatingPeer = onCheatingPeer
    this.onEjectionReady = onEjectionReady
    this.desyncLog = []

    this._detector = new DesyncDetector({
      checksumIntervalTicks,
      expectedPeerIds,
      onDesync: (tick, result) => this._onDesync(tick, result),
      onVerified: (tick, checksum) => this._onVerified(tick, checksum),
    })

    this._peerDesync = new Map()
    for (const pk of expectedPeerIds) {
      this._peerDesync.set(pk, { consecutiveCount: 0, evidenceTicks: [], ejected: false })
    }

    this._onData = ({ detail }) => {
      const msg = decodeCtrl(detail?.data)
      if (!msg || msg.type !== 'checksum' || typeof msg.tick !== 'number' || !msg.pubkey || !msg.checksum) return
      if (msg.pubkey === this.localPeerId || msg.pubkey !== detail.peerPubkey) return
      this._ingestRemoteChecksum(msg.tick, msg.pubkey, msg.checksum)
    }
    this.bridge.data.addEventListener('data', this._onData)

    this.stats = { checksumsSent: 0, checksumsReceived: 0, checksumsIgnored: 0, verified: 0, desyncsDetected: 0, unattributedDesyncs: 0, firstDesyncTick: null, ejectionsFired: 0 }
  }

  tick(tick) {
    this._localTick = tick
    if (!this._detector.isChecksumTick(tick)) return
    const checksum = this.checksumOf(tick)
    this._detector.reportChecksum(tick, this.localPeerId, checksum)
    this.stats.checksumsSent++
    this.bridge.data.broadcast(encodeChecksumMsg(tick, this.localPeerId, checksum))
  }

  removePeer(peerId) {
    const track = this._peerDesync.get(peerId)
    if (track) track.ejected = true
    this._detector.removePeer(peerId)
  }

  _withinChecksumHorizon(tick) {
    if (!this._detector.isChecksumTick(tick)) return false
    const local = this._localTick || 0
    const interval = this._detector.checksumIntervalTicks
    const futureRows = this._detector._maxPendingRows - REMOTE_CHECKSUM_PAST_HORIZON_ROWS - 1
    return tick <= local + futureRows * interval && tick > local - REMOTE_CHECKSUM_PAST_HORIZON_ROWS * interval
  }

  _ingestRemoteChecksum(tick, pubkey, checksum) {
    if (!this._detector.expects(pubkey) || !this._withinChecksumHorizon(tick)) { this.stats.checksumsIgnored++; return }
    this._detector.reportChecksum(tick, pubkey, checksum)
    this.stats.checksumsReceived++
  }

  _onDesync(tick, result) {
    this.stats.desyncsDetected++
    if (this.stats.firstDesyncTick == null) this.stats.firstDesyncTick = tick
    if (this.desyncLog.length < DESYNC_LOG_LIMIT) this.desyncLog.push({ tick, reports: Object.fromEntries(result.reports), offenders: [...result.offenders] })
    if (!result.strictMajority) { this.stats.unattributedDesyncs++; return }
    const { offenders } = result

    for (const [pk, track] of this._peerDesync) {
      if (track.ejected) continue
      if (offenders.includes(pk)) {
        track.consecutiveCount++
        track.evidenceTicks.push(tick)
        if (track.evidenceTicks.length > this.consecutiveDesyncsRequired * 2) {
          track.evidenceTicks = track.evidenceTicks.slice(-this.consecutiveDesyncsRequired)
        }
      } else {
        track.consecutiveCount = 0
        track.evidenceTicks = []
      }
    }

    for (const [pk, track] of this._peerDesync) {
      if (track.ejected) continue
      if (pk === this.localPeerId) continue
      if (track.consecutiveCount >= this.consecutiveDesyncsRequired) {
        track.ejected = true
        this.stats.ejectionsFired++
        const evidence = {
          tick,
          offenderPubkey: pk,
          consecutiveCount: track.consecutiveCount,
          evidenceTicks: [...track.evidenceTicks],
        }
        if (this.onEjectionReady) this.onEjectionReady(pk, { ...evidence, isHost: pk === this.hostPeerId })
        if (pk === this.hostPeerId && this.onCheatingHost) {
          this.onCheatingHost(pk, evidence)
        } else if (pk !== this.hostPeerId && this.onCheatingPeer) {
          this.onCheatingPeer(pk, evidence)
        }
      }
    }
  }

  _onVerified() {
    this.stats.verified++
    for (const [, track] of this._peerDesync) {
      if (track.ejected) continue
      track.consecutiveCount = 0
      track.evidenceTicks = []
    }
  }

  getStats() {
    const peerState = {}
    for (const [pk, track] of this._peerDesync) {
      peerState[pk] = {
        consecutiveCount: track.consecutiveCount,
        evidenceTicks: [...track.evidenceTicks],
        ejected: track.ejected,
      }
    }
    return {
      ...this.stats,
      desyncLog: [...this.desyncLog],
      peers: peerState,
      pendingChecksumRows: this._detector.pendingCount,
    }
  }

  destroy() {
    this.bridge.data.removeEventListener('data', this._onData)
  }
}
