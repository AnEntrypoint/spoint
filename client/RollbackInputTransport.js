// P2P rollback (GGPO-style) input-only wire transport over the existing wireweave data-channel mesh.
//
// rollback-wireweave-p2p-wiring-input-ingestion: the real transport dependency
// rollback-misprediction-detector's own header comment named as missing (that row shipped the DETECTION
// algorithm standalone against a synthetic late-arrival scenario, exactly the precedent
// DesyncDetector.js set for lockstep -- this module is the real wire that produces a genuine
// remote-input-arrival event to feed it). Deliberately a SIBLING of LockstepInputTransport.js, not a
// reuse of it -- the two transports carry the same wire discipline (ordered/reliable per-peer SCTP
// channel, string-CTRL-prefixed JSON frames coexisting with the binary snapshot protocol, roster/
// peer-open/peer-close bookkeeping) but have OPPOSITE consumption semantics:
//   - LockstepInputTransport: caller BLOCKS (waitForTick) until every peer's input for tick T has
//     arrived before simulating T at all -- no speculation, ever.
//   - RollbackInputTransport (this module): caller NEVER blocks. Every tick, the caller predicts every
//     remote peer's input (input-repeat, matching MispredictionDetector.recordPredicted's own documented
//     policy split -- prediction POLICY is the caller's job, this module only ships/receives bytes) and
//     simulates immediately using that prediction. When a remote peer's REAL input for a past tick
//     finally arrives over this transport, this module hands it straight to the caller's own
//     MispredictionDetector.onRemoteInputArrived (via the `onRemoteInput` constructor hook) so a genuine
//     misprediction triggers a real RollbackLoop.resimulateFrom call -- this is the actual wire ingestion
//     rollback-misprediction-detector's own header comment left explicitly out of scope.
//
// Wire format: CTRL_PREFIX 'wwrollback:' (a THIRD distinct string prefix alongside HostMigration's
// 'wwmigrate:' and SnapshotRelay's 'wwrelay:' and LockstepInputTransport's 'wwlockstep:' -- a string
// frame can never collide with the binary msgpack snapshot protocol on the SAME data channel, so this
// coexists with zero demuxing risk, matching every sibling transport's own precedent):
//   { type: 'input', tick, input }
// `input` is caller-supplied and opaque to this module, same as LockstepInputTransport's own contract --
// the actual per-tick command shape (movement/aim/expr fields) is a game concern, not a transport one.
//
// UNLIKE LockstepInputTransport, THIS module does not maintain a `_byTick` ready-check ring at all --
// there is no "tick is ready" concept in rollback (every tick simulates immediately on prediction), so
// there is nothing to make ready. The only bookkeeping this module owns is roster/peer-lifecycle
// (identical discipline to the lockstep sibling, reused verbatim rather than re-invented) plus routing
// each arrived remote frame straight to the caller's onRemoteInput hook.
const CTRL_PREFIX = 'wwrollback:'
function encodeCtrl(obj) { return CTRL_PREFIX + JSON.stringify(obj) }
function decodeCtrl(data) {
  if (typeof data !== 'string' || !data.startsWith(CTRL_PREFIX)) return null
  try { return JSON.parse(data.slice(CTRL_PREFIX.length)) } catch { return null }
}

// A peer silent for this many ticks (no input received for ANY tick) is presumed dead -- identical
// policy/value to LockstepInputTransport's own DEFAULT_STALL_TICKS, reused rather than re-derived since
// the underlying transport-liveness question ("has this mesh peer gone dark") is transport-generic, not
// specific to lockstep-vs-rollback consumption semantics.
const DEFAULT_STALL_TICKS = 180 // ~3s at 60Hz

export class RollbackInputTransport {
  constructor({ bridge, stallTicks = DEFAULT_STALL_TICKS, onRemoteInput = null } = {}) {
    if (!bridge?.data) throw new Error('RollbackInputTransport: bridge.data required')
    this.bridge = bridge
    this.stallTicks = stallTicks
    // onRemoteInput(peerId, tick, arrivedInput) -- the caller's own hook, typically a thin wrapper around
    // MispredictionDetector.onRemoteInputArrived + (if it returns non-null) RollbackLoop.resimulateFrom.
    // Optional: a caller building a pure transport-level witness (no detector/rollback loop in play yet)
    // can omit it and read arrived inputs off getLastArrived()/stats instead, matching the degraded-mode
    // discipline every sibling netcode module in this file already applies to its own optional deps.
    this.onRemoteInput = onRemoteInput

    this._roster = new Set()
    this._dropped = new Set()
    this._lastTickByPeer = new Map() // pubkey -> last tick received FROM that peer (own pubkey included, for symmetry with LockstepInputTransport's identical field)

    this._onData = ({ detail }) => this._handleFrame(detail)
    this._onPeerOpen = ({ detail }) => { if (detail?.peerPubkey) this._roster.add(detail.peerPubkey) }
    this._onPeerClose = ({ detail }) => { if (detail?.peerPubkey) this.dropPeer(detail.peerPubkey) }
    bridge.data.addEventListener('data', this._onData)
    bridge.data.addEventListener('peer-open', this._onPeerOpen)
    bridge.data.addEventListener('peer-close', this._onPeerClose)
    bridge.data.addEventListener('peer-closed', this._onPeerClose)
    for (const [pk, peer] of bridge.data.peers) if (peer?.dc?.readyState === 'open') this._roster.add(pk)

    this.stats = { sent: 0, received: 0, staleIgnored: 0 }
  }

  get myPubkey() { return this.bridge.pubkey }

  // Broadcasts this peer's own input for `tick` to every open mesh peer. Unlike
  // LockstepInputTransport.submitLocalInput, this does NOT also record the input under our own pubkey
  // in a local ready-check ring (there is none) -- a rollback caller already has its own local input
  // immediately (it is the thing driving THIS peer's own prediction/simulation this tick), so re-storing
  // it here would be a redundant second copy of state the caller already owns, not a real need.
  submitLocalInput(tick, input) {
    const me = this.myPubkey
    if (!me) throw new Error('RollbackInputTransport: bridge not connected (no pubkey yet)')
    const n = this.bridge.data.broadcast(encodeCtrl({ type: 'input', tick, input }))
    this.stats.sent++
    return n
  }

  _handleFrame(detail) {
    const msg = decodeCtrl(detail?.data)
    if (!msg || msg.type !== 'input' || typeof msg.tick !== 'number') return
    const from = detail.peerPubkey
    if (!from || from === this.myPubkey) return // never trust a frame claiming to be our own identity
    this._roster.add(from)
    this._dropped.delete(from)
    const last = this._lastTickByPeer.get(from) || -1
    if (msg.tick < last) { this.stats.staleIgnored++ } // still routed through (a late-retransmitted OLD tick can still be a genuine correction for a still-in-window resimulate), just not counted as forward progress
    if (msg.tick > last) this._lastTickByPeer.set(from, msg.tick)
    this.stats.received++
    if (this.onRemoteInput) this.onRemoteInput(from, msg.tick, msg.input)
  }

  // Explicit drop (peer-close, or a caller's own stall-detection policy). Identical semantics to
  // LockstepInputTransport.dropPeer minus the waiter-resolution step (this module has no waiters to
  // unblock -- see the module header's "no ready-check ring" note).
  dropPeer(pubkey) {
    if (!pubkey) return
    this._dropped.add(pubkey)
  }

  // Read-only diagnostic, identical contract to LockstepInputTransport.getStalledPeers -- does NOT drop
  // automatically, drop policy stays the caller's call (RollbackGameLoop.js's own default, mirroring
  // LockstepGameLoop.js's default-drop precedent).
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
    return {
      ...this.stats,
      roster: [...this._roster],
      dropped: [...this._dropped],
      lastTickByPeer: Object.fromEntries(this._lastTickByPeer),
    }
  }

  destroy() {
    this.bridge.data.removeEventListener('data', this._onData)
    this.bridge.data.removeEventListener('peer-open', this._onPeerOpen)
    this.bridge.data.removeEventListener('peer-close', this._onPeerClose)
    this.bridge.data.removeEventListener('peer-closed', this._onPeerClose)
  }
}

export const createRollbackInputTransport = (opts) => new RollbackInputTransport(opts)

export const _test = { CTRL_PREFIX, encodeCtrl, decodeCtrl, DEFAULT_STALL_TICKS }
