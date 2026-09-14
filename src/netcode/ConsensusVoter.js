import { DesyncDetector } from './DesyncDetector.js'
import { checksumBodies } from './LockstepChecksum.js'

const CTRL_PREFIX = 'wwlockstep:'

function encodeChecksumMsg(tick, pubkey, checksum) {
  return CTRL_PREFIX + JSON.stringify({ type: 'checksum', tick, pubkey, checksum })
}

function decodeCtrl(data) {
  if (typeof data !== 'string' || !data.startsWith(CTRL_PREFIX)) return null
  try { return JSON.parse(data.slice(CTRL_PREFIX.length)) } catch { return null }
}

export const DEFAULT_CONSECUTIVE_DESYNCS_REQUIRED = 3

export class ConsensusVoter {
  constructor({
    transport,
    physics,
    localPeerId,
    expectedPeerIds,
    hostPeerId,
    checksumIntervalTicks = 30,
    consecutiveDesyncsRequired = DEFAULT_CONSECUTIVE_DESYNCS_REQUIRED,
    onCheatingHost = null,
    onCheatingPeer = null,
    onEjectionReady = null,
  } = {}) {
    if (!transport?.bridge?.data) throw new Error('[ConsensusVoter] transport (LockstepInputTransport) is required')
    if (!physics || typeof physics.snapshotBodies !== 'function') throw new Error('[ConsensusVoter] physics (PhysicsWorld) is required')
    if (!localPeerId) throw new Error('[ConsensusVoter] localPeerId is required')
    if (!Array.isArray(expectedPeerIds) || expectedPeerIds.length < 2) {
      throw new Error('[ConsensusVoter] expectedPeerIds must be an array of at least 2 peer pubkeys')
    }

    this.transport = transport
    this.physics = physics
    this.localPeerId = localPeerId
    this.hostPeerId = hostPeerId
    this.consecutiveDesyncsRequired = consecutiveDesyncsRequired
    this.onCheatingHost = onCheatingHost
    this.onCheatingPeer = onCheatingPeer
    this.onEjectionReady = onEjectionReady

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
      if (msg.pubkey === this.localPeerId) return
      this._ingestRemoteChecksum(msg.tick, msg.pubkey, msg.checksum)
    }
    this.transport.bridge.data.addEventListener('data', this._onData)

    this.stats = { checksumsSent: 0, checksumsReceived: 0, desyncsDetected: 0, ejectionsFired: 0 }
  }

  tick(tick) {
    if (!this._detector.isChecksumTick(tick)) return

    const snap = this.physics.snapshotBodies()
    const checksum = checksumBodies(tick, snap)
    this._detector.reportChecksum(tick, this.localPeerId, checksum)
    this.stats.checksumsSent++

    const payload = encodeChecksumMsg(tick, this.localPeerId, checksum)
    this.transport.bridge.data.broadcast(payload)
  }

  _ingestRemoteChecksum(tick, pubkey, checksum) {
    try {
      this._detector.reportChecksum(tick, pubkey, checksum)
      this.stats.checksumsReceived++
    } catch (e) {
    }
  }

  _onDesync(tick, result) {
    this.stats.desyncsDetected++
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

  _onVerified(tick, checksum) {
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
      peers: peerState,
      pendingChecksumRows: this._detector.pendingCount,
    }
  }

  destroy() {
    this.transport.bridge.data.removeEventListener('data', this._onData)
  }
}