// P2P lockstep input-only wire transport over the existing wireweave data-channel mesh.
//
// Split off deterministic-fixed-point-lockstep-architecture-for-rts-fighting via the
// lockstep-input-packet-transport-wireweave PRD row. The sibling probe
// (jolt-lockstep-multiprocess-fixed-dt-bit-exact) already proved float64+Jolt is bit-exact across
// independent OS processes given an identical scripted-input sequence and a dt never derived from
// wall-clock/server load -- this module is the part that actually GETS every peer's input for tick N to
// every other peer, which lockstep simulation depends on before it can call physics.step(dt) for that
// tick at all.
//
// Design, against wireweave's REAL guarantees (not assumed -- read directly from
// node_modules/wireweave/src/data.js and this repo's own client/HostMigration.js /
// client/SnapshotRelay.js precedent, which already exercise the same primitives live in production):
//   - DataSession forms a real full-mesh (every-pair, not hub-and-spoke) set of WebRTC RTCDataChannels
//     (see client/HostMigration.js's own header note "wireweave's DataSession already forms a real, open
//     WebRTC data channel between EVERY pair of room participants"), each created with the default
//     `{ ordered: true }` dataChannelOptions (client/WireweaveBridge.js's createDataSession call passes no
//     override) -- SCTP-backed ordered+reliable delivery PER PEER-PAIR. That is exactly the guarantee a
//     lockstep input broadcast needs (every peer's own input stream must arrive in-order at every other
//     peer), and it comes for free from the existing transport with zero protocol change.
//   - There is NO built-in multicast/room-broadcast beyond `DataSession.broadcast()`, which is already a
//     plain per-peer loop over the mesh (see data.js) -- this module rides that unchanged rather than
//     re-inventing fan-out.
//   - There is NO delivery-ordering guarantee ACROSS different peers' streams (only within one peer's own
//     channel), which is exactly why a lockstep consumer must NOT assume it has "all of tick N" until it
//     has explicitly received tick N (or later) from every peer it currently knows about -- this module's
//     `waitForTick`/`getReadyTick` do that bookkeeping explicitly rather than trusting arrival order.
//   - A peer's data channel can legitimately not be open yet (mesh negotiation still in flight) or can
//     close mid-session (see HostMigration.js's peer-close handling) -- an unreachable peer would otherwise
//     wedge lockstep forever waiting for an input that will never arrive. This module tracks the CURRENT
//     open-peer roster itself (peer-open/peer-close, mirroring HostMigration.js's own listener discipline)
//     and a tick is "ready" once every peer in the roster AT THE TIME that tick opened has supplied an
//     input (or been marked dropped for that tick after a bounded per-tick wait -- see markPeerTimedOut).
//
// Wire format: one string-prefixed JSON control frame per input packet, matching the CTRL_PREFIX
// convention client/HostMigration.js ('wwmigrate:') and client/SnapshotRelay.js ('wwrelay:') already
// established (a string frame can never collide with the binary msgpack game-snapshot protocol, so this
// coexists on the SAME data channel with zero demuxing risk):
//   { type: 'input', tick, input }
// `input` is caller-supplied and opaque to this module (the actual per-tick command/order shape is a
// lockstep-game concern, not a transport concern) -- JSON-serializable only (no binary payload support in
// this first slice; a real RTS/fighting input packet -- a handful of button/axis fields -- is tiny and
// JSON-fine, unlike the multi-KB SNAPSHOT bytes SnapshotRelay.js has to base64-wrap).
const CTRL_PREFIX = 'wwlockstep:'
function encodeCtrl(obj) { return CTRL_PREFIX + JSON.stringify(obj) }
function decodeCtrl(data) {
  if (typeof data !== 'string' || !data.startsWith(CTRL_PREFIX)) return null
  try { return JSON.parse(data.slice(CTRL_PREFIX.length)) } catch { return null }
}

// GGPO-style input-delay default: every peer submits tick N's input INPUT_DELAY_TICKS ticks before local
// simulation reaches N, hiding real P2P RTT behind a fixed, predictable buffer instead of stalling
// simulation on the SLOWEST peer's live network latency every single tick. Caller-overridable via the
// `inputDelayTicks` constructor option -- there is no single correct value (it trades input latency
// against stall frequency, and the right number depends on the actual peer-to-peer RTT of a given
// session), so this is a tuning default, not a hardcoded protocol constant.
const DEFAULT_INPUT_DELAY_TICKS = 2

// A peer that has gone completely silent for this many ticks (no input received for ANY tick, not just
// the current one) is presumed to have a dead/closing data channel even if 'peer-close' hasn't fired yet
// (WebRTC connection-state transitions are not instant -- see wireweave's own DISCONNECT_GRACE in data.js)
// -- markPeerTimedOut can be called explicitly by the host app once this elapses, or a caller can poll
// getStalledPeers() and decide its own policy (drop from roster vs. pause vs. desync-recover, which is the
// separate lockstep-desync-detection-and-recovery row's concern, not this transport's).
const DEFAULT_STALL_TICKS = 180 // ~3s at 60Hz

export class LockstepInputTransport {
  constructor({ bridge, inputDelayTicks = DEFAULT_INPUT_DELAY_TICKS, stallTicks = DEFAULT_STALL_TICKS } = {}) {
    if (!bridge?.data) throw new Error('LockstepInputTransport: bridge.data required')
    this.bridge = bridge
    this.inputDelayTicks = inputDelayTicks
    this.stallTicks = stallTicks

    // tick -> Map(pubkey -> input). Own local input is stored under the local pubkey too, so
    // getTickInputs/waitForTick treat "my own input" and "a remote peer's input" uniformly -- the
    // simulation consumer should never special-case which entries came from the network vs. locally.
    this._byTick = new Map()
    // pubkey -> last tick we actually received an input for (own pubkey included, bumped by submitLocalInput).
    this._lastTickByPeer = new Map()
    // Roster of peers this transport currently expects input from. Seeded from bridge.data.peers (already
    // open ones) at construction, kept live via peer-open/peer-close -- mirrors HostMigration.js's own
    // "attach to already-open peers at install time, then listen for later ones" pattern, since a peer
    // may already be connected before this module is installed (e.g. late joiner installing lockstep after
    // its own mesh handshake settled).
    this._roster = new Set()
    // pubkey -> true once explicitly dropped (stalled/left) -- excluded from readiness checks from then on
    // without needing to mutate `_roster` (keeps peer identity history around for debugging via getStats()).
    this._dropped = new Set()
    // tick -> array of resolver functions waiting on that tick becoming ready (see waitForTick).
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

  // The tick a locally-submitted input actually targets, given the configured input-delay buffer --
  // callers submit for `localTick + inputDelayTicks`, never for the tick they are CURRENTLY simulating
  // (submitting for the current tick would defeat the whole point of the delay buffer: every OTHER peer
  // would also need that input to have already arrived before this tick could simulate, i.e. zero delay).
  targetTickFor(localTick) { return localTick + this.inputDelayTicks }

  // Broadcasts this peer's own input for `tick` to every open mesh peer AND records it locally under our
  // own pubkey (see the _byTick comment -- local input goes through the identical bookkeeping path a
  // remote arrival would, so a single-player/no-peers-yet session still populates ticks correctly and
  // `waitForTick` degrades naturally to "wait for just my own input" when the roster is empty).
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
    if (!from || from === this.myPubkey) return // never trust a frame claiming to be our own identity
    this._roster.add(from) // a frame arriving is itself proof this peer is live, even before peer-open fired
    this._dropped.delete(from)
    this._record(tick_from(msg), from, msg.input)
  }

  _record(tick, pubkey, input) {
    let m = this._byTick.get(tick)
    if (!m) { m = new Map(); this._byTick.set(tick, m) }
    if (m.has(pubkey)) { this.stats.duplicatesIgnored++; return } // idempotent: a resend/replay of an already-applied tick is a no-op, never overwritten
    m.set(pubkey, input)
    this.stats.received++
    const last = this._lastTickByPeer.get(pubkey) || -1
    if (tick > last) this._lastTickByPeer.set(pubkey, tick)
    this._maybeResolve(tick)
  }

  // A tick is ready once every currently-expected peer (roster minus dropped) has an entry in that tick's
  // map. Deliberately snapshots the roster AT THE TIME of the check, not a fixed set captured once at
  // construction -- a peer that joins mid-session (mesh grows) or leaves (dropPeer) changes what "everyone"
  // means for ticks not yet ready, exactly like a real lockstep session's participant set can change
  // between rounds.
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

  // Resolves once `tick` is ready (see isTickReady). Returns the same shape getTickInputs would. Does not
  // reject on timeout by itself -- callers that want a bounded wait should race this against their own
  // setTimeout, since "how long to wait before treating a peer as stalled" is a policy decision belonging
  // to the lockstep game loop (lockstep-tick-driver-bypass-dilation), not this transport.
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

  // Explicit drop (peer-close, or a caller's own stall-detection policy calling this after observing
  // getStalledPeers()). Removing a peer from readiness checks can immediately unblock any tick that was
  // only waiting on that one peer -- re-checks every currently-pending waiter tick, not just the latest,
  // since a slow-to-notice caller could have several ticks queued up behind one stalled peer.
  dropPeer(pubkey) {
    if (!pubkey || this._dropped.has(pubkey)) return
    this._dropped.add(pubkey)
    for (const tick of this._waiters.keys()) this._maybeResolve(tick)
  }

  // Peers present in the roster whose most-recently-seen input tick is more than `stallTicks` behind the
  // given `nowTick` (the caller's own current simulation tick) -- a read-only diagnostic, does NOT drop
  // automatically (see dropPeer's own doc: drop policy is the game loop's call, e.g. after also trying a
  // desync-recovery resync per the sibling lockstep-desync-detection-and-recovery row).
  getStalledPeers(nowTick) {
    const out = []
    for (const pk of this._roster) {
      if (this._dropped.has(pk)) continue
      const last = this._lastTickByPeer.get(pk)
      if (last === undefined || nowTick - last > this.stallTicks) out.push({ pubkey: pk, lastTick: last ?? -1 })
    }
    return out
  }

  // Bounded memory: once every peer's simulation has definitely moved past `beforeTick` (the caller's own
  // job to know, since only it tracks "the earliest tick any consumer still needs" -- this module has no
  // opinion on simulation progress), drop older tick buckets and any now-moot waiters for them so a
  // long-running lockstep session doesn't grow this._byTick unboundedly.
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

// msg.tick arrives through JSON so it's already a plain number -- named helper only so _handleFrame reads
// as "extract the tick" rather than a bare property access buried in the _record call.
function tick_from(msg) { return msg.tick }

export const createLockstepInputTransport = (opts) => new LockstepInputTransport(opts)

export const _test = { CTRL_PREFIX, encodeCtrl, decodeCtrl, DEFAULT_INPUT_DELAY_TICKS, DEFAULT_STALL_TICKS }
