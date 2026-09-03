// lockstep-desync-wireweave-transport-and-tickhandler-wiring: the PRODUCTION wiring for
// DesyncDetector.js/LockstepChecksum.js over the real wireweave mesh, plus the TickHandler-side
// simulateTick hook a lockstep game mode calls once both dependency rows (lockstep-tick-driver-
// bypass-dilation, lockstep-input-packet-transport-wireweave) had landed as standalone primitives.
//
// SCOPE (per this row's own PRD detail, all three sub-items):
//   (a) broadcast this peer's own reportChecksum(tick,peerId,checksum) to every other peer over
//       wireweave, and feed remote peers' reports into the SAME local DesyncDetector instance;
//   (b) onDesync triggers a real hard-pause+resync UX: freeze local simulation, request the
//       majority-matching peer's full snapshotBodies() over the transport, recoverSnapshot, resume;
//   (c) the authoritative-peer-selection policy for the state PUSH: lowest pubkey (lexicographic)
//       among the majority-agreeing peer set -- a real, deterministic, decidable-by-every-peer-
//       independently policy (every peer computes the identical winner from the SAME desync result
//       payload, no election round-trip needed, mirroring HostMigration.js's own RTT-table
//       independently-computed-winner precedent named in that file's own header comment).
//
// Wire convention: same string-prefixed-JSON control-frame pattern as every other wireweave-mesh
// module in this repo (client/HostMigration.js 'wwmigrate:', client/SnapshotRelay.js 'wwrelay:',
// client/LockstepInputTransport.js 'wwlockstep:') -- a string frame can never collide with the
// binary msgpack game-snapshot protocol on the same data channel, so this coexists with zero
// demuxing risk. Three frame types on this module's own prefix:
//   { type: 'checksum', tick, checksum }              -- broadcast every isChecksumTick
//   { type: 'snapshot-request', tick, forPeer }        -- sent to the resolved authoritative peer only
//   { type: 'snapshot-response', tick, snap }          -- snap is DesyncDetector-shaped Map, wire-serialized as an array of [id, body] pairs (JSON has no Map)
const CTRL_PREFIX = 'wwdesync:'
function encodeCtrl(obj) { return CTRL_PREFIX + JSON.stringify(obj) }
function decodeCtrl(data) {
  if (typeof data !== 'string' || !data.startsWith(CTRL_PREFIX)) return null
  try { return JSON.parse(data.slice(CTRL_PREFIX.length)) } catch { return null }
}

// snapshotBodies() returns a Map<id, {position,rotation,velocity,angularVelocity}> -- JSON.stringify
// silently serializes a Map as `{}` (loses every entry), so the wire payload must go through an
// explicit array-of-pairs round trip. Kept as two small named helpers (not inlined at each call site)
// so the wire shape has one definition shared by both the request-response send and the recoverSnapshot
// consumer below.
function snapToWire(snap) { return [...snap.entries()] }
function snapFromWire(pairs) { return new Map(pairs) }

export class LockstepDesyncTransport {
  // `detector` is a real DesyncDetector instance (constructed by the caller with its own
  // expectedPeerIds/onDesync/onVerified -- this module never constructs one itself, matching
  // DesyncDetector's own "transport-independent, caller supplies checksums however it likes" design).
  // `physics` is this peer's own PhysicsWorld (for snapshotBodies()/restoreBodies() during recovery).
  // `onPause`/`onResume` are optional caller hooks for the hard-pause UX (b) -- e.g. freezing the local
  // tick driver's callback loop or showing a resync indicator; both default to no-ops so a caller that
  // doesn't need pause/resume visuals (a headless/test peer) can omit them.
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
    // Pending snapshot-requests this peer is AWAITING a response for (tick -> resolver), so a caller
    // driving the pause/resume flow can await requestSnapshotFrom's returned promise instead of polling.
    this._pendingSnapshotRequests = new Map()

    this._onData = ({ detail }) => this._handleFrame(detail)
    bridge.data.addEventListener('data', this._onData)

    // Wire this instance's own detector.onDesync straight into the recovery flow (b)+(c) -- a caller
    // that already passed its own onDesync to the DesyncDetector constructor is NOT overridden here;
    // DesyncDetector's constructor option and this module's own reaction are independent listeners a
    // caller can layer (e.g. the constructor option only logs/telemetries, this module does the actual
    // resync). Achieved by wrapping, not replacing, whatever onDesync the caller already set.
    const priorOnDesync = detector.onDesync
    detector.onDesync = (tick, result) => {
      if (priorOnDesync) { try { priorOnDesync(tick, result) } catch (e) { console.error('[LockstepDesyncTransport] prior onDesync threw:', e?.message || e) } }
      this._handleDesync(tick, result).catch(e => console.error('[LockstepDesyncTransport] recovery failed:', e?.message || e))
    }
  }

  get myPubkey() { return this.bridge.pubkey }

  // Broadcasts this peer's own checksum for `tick` to the mesh AND feeds it into the local detector
  // immediately (matching LockstepInputTransport.submitLocalInput's identical "local write goes through
  // the same bookkeeping path a remote arrival would" discipline, so a solo/no-peers-yet session still
  // resolves correctly). A caller's lockstep tick loop calls this exactly on ticks where
  // detector.isChecksumTick(tick) is true (see the header comment on that method in DesyncDetector.js) --
  // this module does not gate the call itself since the detector already owns that cadence decision.
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
    if (!from || from === this.myPubkey) return // never trust a frame claiming to be our own identity
    if (msg.type === 'checksum' && typeof msg.tick === 'number' && typeof msg.checksum === 'string') {
      this.detector.reportChecksum(msg.tick, from, msg.checksum)
    } else if (msg.type === 'snapshot-request' && msg.forPeer === this.myPubkey) {
      // Only the resolved authoritative peer (see _handleDesync's pubkey-comparison below) is ever
      // addressed as forPeer -- every non-authoritative peer's identical frame is silently ignored by
      // this branch since forPeer !== their own pubkey, exactly the discipline HostMigration.js's own
      // per-target addressed frames use.
      const snap = this.physics.snapshotBodies()
      this.bridge.data.send(from, encodeCtrl({ type: 'snapshot-response', tick: msg.tick, snap: snapToWire(snap) }))
    } else if (msg.type === 'snapshot-response' && typeof msg.tick === 'number') {
      const resolver = this._pendingSnapshotRequests.get(msg.tick)
      if (resolver) { this._pendingSnapshotRequests.delete(msg.tick); resolver(snapFromWire(msg.snap)) }
    }
  }

  // (c) authoritative-peer-selection: lowest pubkey (lexicographic) among the desync result's
  // majority-agreeing peers -- every peer independently computes the SAME winner from the identical
  // `result.reports`/`result.majorityChecksum` payload DesyncDetector.onDesync already hands every
  // listener, with zero election round-trip. A peer whose OWN checksum already equals majorityChecksum
  // (i.e. this peer is not itself desynced) never needs to request anything -- only an offending peer
  // pulls a fresh snapshot; a correctly-synced peer that happens to not be the chosen authority just
  // continues simulating normally.
  _pickAuthoritativePeer(result) {
    const majority = []
    for (const [pk, cs] of result.reports) if (cs === result.majorityChecksum) majority.push(pk)
    majority.sort()
    return majority[0] || null
  }

  async _handleDesync(tick, result) {
    const me = this.myPubkey
    const myChecksum = result.reports.get(me)
    if (myChecksum === result.majorityChecksum) return // this peer already matches the majority -- no recovery needed locally
    const authority = this._pickAuthoritativePeer(result)
    if (!authority || authority === me) {
      // No reachable majority peer to resync from (e.g. every report disagreed pairwise, or this peer
      // itself was picked despite being an offender -- can only happen if `me` ties into `majority`
      // while ALSO not matching majorityChecksum, which reportChecksum's own offenders[] computation
      // already rules out structurally: offenders are exactly the peers whose checksum !== majority).
      console.error(`[LockstepDesyncTransport] desync at tick ${tick} but no authoritative peer resolvable (offenders: ${result.offenders.join(',')})`)
      return
    }
    this.recovering = true
    if (this.onPause) { try { this.onPause(tick, result) } catch (_) {} }
    try {
      const snap = await this._requestSnapshotFrom(authority, tick)
      // recoverSnapshot is imported lazily by the caller-constructed detector module's own sibling --
      // this module deliberately calls physics.restoreBodies directly (the same primitive
      // DesyncDetector.recoverSnapshot wraps) rather than importing DesyncDetector.js's function export
      // a second time, avoiding a circular-import risk between the two sibling modules.
      this.physics.restoreBodies(snap)
    } finally {
      this.recovering = false
      if (this.onResume) { try { this.onResume(tick, result) } catch (_) {} }
    }
  }

  // Sends a snapshot-request to `authority` and returns a Promise resolving with the deserialized Map
  // once that peer's snapshot-response arrives. No built-in timeout (mirrors LockstepInputTransport.
  // waitForTick's identical "policy belongs to the caller" stance) -- a caller wanting a bounded wait
  // races this against its own setTimeout/AbortSignal.
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
