// lockstep-desync-detection-and-recovery: periodic per-peer state-checksum exchange + resync strategy.
//
// SCOPE (honest first slice, per this row's own PRD detail): the DETECTION + RECOVERY mechanism only,
// transport-independent -- this module never touches wireweave/the mesh directly, matching RollbackLoop.js's
// own precedent of shipping "usable standalone against ANY tick-boundary trigger a future caller supplies"
// since lockstep-input-packet-transport-wireweave (the real P2P input-only wire protocol) is still a pending
// sibling row with no transport to wire against yet. A caller supplies checksums however it likes (today: a
// direct function call in a same-process multi-peer test harness, matching how lockstep-worker.mjs's own
// probe compared checksums across forked processes; tomorrow: a wireweave message once the sibling transport
// row lands) and this module does the comparison/quorum/resync-trigger logic that is genuinely reusable
// regardless of transport.
//
// DESIGN: every peer periodically computes its own checksumBodies(tick, physics.snapshotBodies()) (see
// LockstepChecksum.js) for the SAME agreed-upon tick and reports it in. Once every expected peer has
// reported for a given tick, compare: if all checksums for that tick match, the tick is verified-in-sync and
// its record is dropped (no reason to keep verified history). If they DON'T all match, a desync is detected
// -- lockstep alone has no rollback (RollbackLoop.js's window is a LOCAL misprediction-correction mechanism,
// not a cross-peer resync path, and lockstep by definition has no authoritative server to already hold a
// trusted state the way rollback's local ring buffer does), so recovery is a full-state RESYNC PUSH from one
// designated authoritative peer, reusing PhysicsWorld.snapshotBodies/restoreBodies exactly as this row's own
// PRD detail specifies -- never re-deriving a new snapshot mechanism.
//
// QUORUM CHOICE: majority-checksum-wins (the checksum value reported by the largest peer subset is treated
// as ground truth), not "peer 0 is always right" -- a desync could originate at the designated host's own
// build/platform just as easily as at a follower's (this is exactly the scenario the row's own detail names:
// "a peer on a different Jolt/Node/V8 build"), so picking a fixed peer as always-authoritative would silently
// propagate ITS corruption to every correctly-simulating follower in a tie or host-is-wrong case. Majority is
// the honest default; the authoritative-peer id used for the actual state PUSH (recoverSnapshot) is still
// caller-supplied (typically whichever real peer already holds the majority-matching state), matching how a
// P2P mesh has no server that could unilaterally decide otherwise.
export const DEFAULT_CHECKSUM_INTERVAL_TICKS = 30 // 0.5s at 60Hz -- frequent enough to bound how far a desync can silently drift, cheap enough (one checksum computation + a handful of bytes) to run continuously

export class DesyncDetector {
  constructor({ checksumIntervalTicks = DEFAULT_CHECKSUM_INTERVAL_TICKS, expectedPeerIds, onDesync = null, onVerified = null } = {}) {
    if (!Array.isArray(expectedPeerIds) || expectedPeerIds.length === 0) {
      throw new Error('[DesyncDetector] expectedPeerIds (the full peer roster for this lockstep session) is required')
    }
    this.checksumIntervalTicks = checksumIntervalTicks
    this.expectedPeerIds = [...expectedPeerIds]
    this.onDesync = onDesync // (tick, {reports: Map<peerId,checksum>, majorityChecksum, offenders: peerId[]}) => void
    this.onVerified = onVerified // (tick, checksum) => void, optional -- lets a caller prune its own local snapshot history once a tick is confirmed in-sync
    // tick -> Map<peerId, checksum-string>; a pending row is dropped once either fully reported (resolved,
    // verified or desynced) or `maxPendingTicks` newer pending ticks have superseded it (a peer that never
    // reports for a tick -- dropped packet, dead peer -- must not leak memory forever holding that row open).
    this._pending = new Map()
    this._resolvedTicks = [] // small ring of recently-resolved tick numbers, bounded, for isTickDue()/introspection only
    this._maxPendingRows = 64 // bounded independent of maxPendingTicks below -- a defensive cap on total pending Map size regardless of tick spacing
  }

  // True on ticks where every peer should compute+report a checksum -- a caller's tick loop calls this once
  // per tick and only pays checksumBodies' O(bodies) cost when it returns true.
  isChecksumTick(tick) { return tick % this.checksumIntervalTicks === 0 }

  // Records one peer's reported checksum for `tick`. Returns the resolution result once every expected peer
  // has reported for that tick ({status:'verified'|'desync', ...}), or null while still awaiting more reports.
  reportChecksum(tick, peerId, checksum) {
    if (!this.expectedPeerIds.includes(peerId)) {
      throw new Error(`[DesyncDetector] checksum reported by unknown peer ${peerId}, not in expectedPeerIds`)
    }
    let row = this._pending.get(tick)
    if (!row) {
      row = new Map()
      this._pending.set(tick, row)
      this._evictOverflow()
    }
    row.set(peerId, checksum)
    if (row.size < this.expectedPeerIds.length) return null // still waiting on other peers for this tick
    return this._resolve(tick, row)
  }

  _resolve(tick, row) {
    this._pending.delete(tick)
    this._resolvedTicks.push(tick)
    if (this._resolvedTicks.length > 128) this._resolvedTicks.shift()

    const counts = new Map() // checksum -> count
    for (const cs of row.values()) counts.set(cs, (counts.get(cs) || 0) + 1)
    let majorityChecksum = null, majorityCount = -1
    for (const [cs, count] of counts) { if (count > majorityCount) { majorityChecksum = cs; majorityCount = count } }

    if (counts.size === 1) {
      // Every peer agrees -- fully verified-in-sync tick.
      if (this.onVerified) this.onVerified(tick, majorityChecksum)
      return { status: 'verified', tick, checksum: majorityChecksum }
    }

    const offenders = []
    for (const [peerId, cs] of row) if (cs !== majorityChecksum) offenders.push(peerId)
    const result = { status: 'desync', tick, reports: row, majorityChecksum, offenders }
    if (this.onDesync) this.onDesync(tick, result)
    return result
  }

  // A pending row for a tick that will never fully report (a peer disconnected mid-exchange) must not pin
  // memory forever -- called by a caller's own timeout/disconnect handling, or automatically bounded by
  // _evictOverflow below as a defensive floor even if a caller never calls this explicitly.
  dropPending(tick) { this._pending.delete(tick) }

  _evictOverflow() {
    while (this._pending.size > this._maxPendingRows) {
      const oldest = this._pending.keys().next().value
      this._pending.delete(oldest)
    }
  }

  get pendingCount() { return this._pending.size }
}

// Recovery strategy: full-state resync push from one designated authoritative peer, reusing
// PhysicsWorld.snapshotBodies()/restoreBodies(snap) exactly as this row's own PRD detail specifies -- no new
// snapshot mechanism invented. `physics` is the OFFENDING (desynced) peer's own PhysicsWorld; `authoritativeSnap`
// is the Map (or plain-object wire-deserialized equivalent) obtained from the authoritative peer's
// physics.snapshotBodies() call, transported however the caller's transport layer delivers it. Mirrors
// RollbackLoop.js's own restoreBodies usage (same primitive, same EActivation_Activate-on-restore semantics
// documented on World.js:381) -- a resync is architecturally "roll every dynamic body back to a known-good
// external snapshot", identical to a rollback restore except the snapshot's SOURCE is a remote peer instead
// of this process's own local ring buffer.
export function recoverSnapshot(physics, authoritativeSnap) {
  if (!physics || typeof physics.restoreBodies !== 'function') {
    throw new Error('[DesyncDetector] recoverSnapshot requires a PhysicsWorld exposing restoreBodies')
  }
  physics.restoreBodies(authoritativeSnap)
}
