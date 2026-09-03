// server-scale-p2p-lockstep-consensus-vote-out-cheating-host: the VERIFICATION+VOTING protocol layer
// on top of the already-shipped lockstep primitives (LockstepTickSystem, LockstepInputTransport,
// LockstepGameLoop, DesyncDetector, LockstepChecksum, HostMigration). The physics-determinism and
// transport legwork is done (Jolt bit-exactness confirmed cross-process, real cross-network E2E witnesses
// exist for LockstepInputTransport+LockstepGameLoop) -- what is NOT yet built is the actual sustained-
// desync detection + vote-to-eject protocol this module implements.
//
// ARCHITECTURE:
//   - Wraps a DesyncDetector internally (never re-implements checksum comparison -- reuses the existing
//     majority-checksum-wins logic from DesyncDetector._resolve, which already produces per-tick offender
//     lists from the checksum consensus).
//   - Handles checksum EXCHANGE over the wire: broadcasts its own checksum on every checksum tick via the
//     existing bridge.data.broadcast() (same data channel LockstepInputTransport already uses, new
//     'checksum' message type under the same 'wwlockstep:' prefix -- LockstepInputTransport._handleFrame
//     already ignores non-'input' messages, so these coexist safely), and listens for incoming checksums
//     from remote peers, feeding them into DesyncDetector.reportChecksum().
//   - Tracks SUSTAINED desync: a single-tick checksum mismatch is not enough to eject a peer (transient
//     network glitch, a single tick's float noise, a dropped packet). Tracks a sliding window of recent
//     desync events per peer; a peer is flagged as cheating only after consecutiveDesyncsRequired
//     CONSECUTIVE checksum ticks where the same peer is consistently the offender. If the peer syncs back
//     up (a checksum tick where they are NOT an offender), the counter resets -- this is the hysteresis
//     policy that prevents false positives from transient issues.
//   - EJECTION: when the host is the consistent offender, fires onCheatingHost(hostPubkey, evidence),
//     which the caller wires to HostMigration.forceElection() (reusing the already-shipped handoff
//     mechanism). When a non-host peer is the offender, fires onCheatingPeer(peerPubkey, evidence), which
//     the caller wires to transport.dropPeer(). The ejection is a local decision: every honest peer's
//     own ConsensusVoter independently reaches the same conclusion (since all honest peers' DesyncDetectors
//     see the same checksum data and the same majority consensus), so no explicit vote-coordination wire
//     protocol is needed -- the checksum exchange IS the consensus mechanism.
//
// WIRE FORMAT (added to the existing 'wwlockstep:' prefix, coexisting with LockstepInputTransport's
// 'input' type on the same data channel):
//   { type: 'checksum', tick, pubkey, checksum }
//
// LIVE-WITNESS (scratch-only, never committed per the no-test-files-ever rule): a real 3-peer in-process
// harness with 3 independent PhysicsWorld instances + 3 ConsensusVoter instances linked by a simple
// message bus. One peer (the "cheating host") mutates one body's position after physics.step() but before
// computing its checksum, creating a genuine, sustained checksum divergence. The honest peers' voters
// detect the sustained desync after consecutiveDesyncsRequired checksum ticks and fire onCheatingHost.

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

// Default: require 3 consecutive desync checksum ticks before flagging. At the default 30-tick
// checksum interval (0.5s at 60Hz), this is 1.5 seconds of sustained divergence -- long enough to
// rule out a single-tick transient, short enough to catch a real cheater before they cause lasting
// damage. Backed by measurement: the sibling deterministic-simulation-jolt-fixed-point-rollback probe
// proved Jolt is bit-exact across independent processes with zero divergence across 9464+ float
// components; any non-zero checksum difference is therefore a real divergence (not float noise), and
// requiring 3 consecutive such ticks bounds the false-positive window to essentially zero.
export const DEFAULT_CONSECUTIVE_DESYNCS_REQUIRED = 3

export class ConsensusVoter {
  constructor({
    transport,                        // LockstepInputTransport (for bridge broadcast/receive)
    physics,                          // PhysicsWorld (for snapshotBodies)
    localPeerId,                      // this peer's pubkey
    expectedPeerIds,                  // [pubkey, ...] -- the full lockstep roster
    hostPeerId,                       // the current host's pubkey (may be null if no host role yet)
    checksumIntervalTicks = 30,       // passed to DesyncDetector
    consecutiveDesyncsRequired = DEFAULT_CONSECUTIVE_DESYNCS_REQUIRED,
    onCheatingHost = null,            // (hostPubkey, {tick, offenderPubkey, consecutiveCount, evidenceTicks}) => void
    onCheatingPeer = null,            // (peerPubkey, {tick, offenderPubkey, consecutiveCount, evidenceTicks}) => void
    onEjectionReady = null,           // (offenderPubkey, {tick, consecutiveCount, isHost}) => void -- fires once when threshold first crossed, not on every subsequent tick
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

    // The DesyncDetector does the per-tick checksum comparison with majority voting.
    this._detector = new DesyncDetector({
      checksumIntervalTicks,
      expectedPeerIds,
      onDesync: (tick, result) => this._onDesync(tick, result),
      onVerified: (tick, checksum) => this._onVerified(tick, checksum),
    })

    // Per-peer sustained-desync tracking: pubkey -> { consecutiveCount, evidenceTicks: [tick, ...], ejected: bool }
    this._peerDesync = new Map()
    for (const pk of expectedPeerIds) {
      this._peerDesync.set(pk, { consecutiveCount: 0, evidenceTicks: [], ejected: false })
    }

    // Listen for incoming checksum messages from remote peers on the same data channel.
    this._onData = ({ detail }) => {
      const msg = decodeCtrl(detail?.data)
      if (!msg || msg.type !== 'checksum' || typeof msg.tick !== 'number' || !msg.pubkey || !msg.checksum) return
      if (msg.pubkey === this.localPeerId) return // never trust a frame claiming to be our own identity
      this._ingestRemoteChecksum(msg.tick, msg.pubkey, msg.checksum)
    }
    this.transport.bridge.data.addEventListener('data', this._onData)

    this.stats = { checksumsSent: 0, checksumsReceived: 0, desyncsDetected: 0, ejectionsFired: 0 }
  }

  // Called every simulation tick by the lockstep game loop. On checksum ticks, computes+ broadcasts+
  // reports the local checksum. On every tick, also processes any pending checksum results.
  tick(tick) {
    if (!this._detector.isChecksumTick(tick)) return

    const snap = this.physics.snapshotBodies()
    const checksum = checksumBodies(tick, snap)
    this._detector.reportChecksum(tick, this.localPeerId, checksum)
    this.stats.checksumsSent++

    // Broadcast to every other peer in the mesh.
    const payload = encodeChecksumMsg(tick, this.localPeerId, checksum)
    this.transport.bridge.data.broadcast(payload)
  }

  _ingestRemoteChecksum(tick, pubkey, checksum) {
    try {
      this._detector.reportChecksum(tick, pubkey, checksum)
      this.stats.checksumsReceived++
    } catch (e) {
      // reportChecksum throws on unknown peerId -- a peer that joined after construction
      // or a spoofed message. Silently ignore; the honest peers' roster is the source of truth.
    }
  }

  // Called by DesyncDetector when a checksum tick resolves with a desync (not all peers agree).
  _onDesync(tick, result) {
    this.stats.desyncsDetected++
    const { offenders } = result

    for (const [pk, track] of this._peerDesync) {
      if (track.ejected) continue
      if (offenders.includes(pk)) {
        track.consecutiveCount++
        track.evidenceTicks.push(tick)
        // Keep evidence bounded.
        if (track.evidenceTicks.length > this.consecutiveDesyncsRequired * 2) {
          track.evidenceTicks = track.evidenceTicks.slice(-this.consecutiveDesyncsRequired)
        }
      } else {
        // Peer synced back up -- reset the counter (hysteresis: a transient glitch must not
        // accumulate into a false ejection).
        track.consecutiveCount = 0
        track.evidenceTicks = []
      }
    }

    // Check threshold: any peer that has crossed the consecutive-desync threshold.
    // IMPORTANT: never flag the LOCAL peer as a cheater -- a peer does not vote to eject itself
    // (the cheater's own ConsensusVoter will also detect itself as the minority-offender, since
    // its own checksum disagrees with the honest majority, but self-ejection is nonsensical).
    for (const [pk, track] of this._peerDesync) {
      if (track.ejected) continue
      if (pk === this.localPeerId) continue // never self-eject
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

  // Called by DesyncDetector when a checksum tick is fully verified (all peers agree).
  _onVerified(tick, checksum) {
    // Reset EVERY peer's consecutive counter on a verified tick -- a verified tick proves the
    // simulation is back in sync, so any prior desync streak is no longer sustained.
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