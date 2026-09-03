// P2P mesh: redundant SNAPSHOT relay over already-open joiner-joiner data channel edges.
//
// Problem this fixes (p2p-mesh-redundant-snapshot-relay-via-joiner-joiner-edges): wireweave's DataSession
// already forms a real, open WebRTC data channel between EVERY pair of room participants (confirmed live --
// see client/HostMigration.js's file header for the same finding), but outside a host-migration event
// (HostMigration.js) those joiner-joiner edges carry zero game traffic. Normal-operation SNAPSHOT delivery
// flows exclusively host->joiner over each joiner's single edge to the host (client/BrowserServer.js's
// PEER_SEND / client/WireweaveJoinClient.js's onData), so a joiner with a degraded/lossy link to the host
// specifically -- but healthy links to OTHER joiners -- has no redundancy today, defeating a genuine mesh
// architecture's core promised benefit.
//
// Design (bounded first slice, reuses zero new connections, zero server/wire-protocol changes):
//   - Joiner-requested trigger (installSnapshotRelayJoiner's own missed-snapshot-streak watch, added for
//     p2p-mesh-joiner-requested-snapshot-relay-on-missed-acks): the host-driven bufferedAmount signal
//     above only catches a slow-DRAIN congestion pattern on the HOST's OUTBOUND buffer -- it can miss a
//     lossy/asymmetric path where packets (or their acks) never reach the joiner at all without the
//     host's own send buffer ever backing up (a one-way-lossy NAT/relay hop is a real, distinct failure
//     mode from congestion). This module also polls -- on the SAME already-open joiner side, mirroring
//     HostMigration.js's own election-trigger discipline (a periodic check + a consecutive-streak
//     requirement, never a single-sample trip) -- whether `client.currentTick` (BaseClient's own
//     unconditionally-updated per-accepted-SNAPSHOT counter, see src/client/BaseClient.js's _onSnapshot)
//     has advanced since the last check. `client.currentTick` stays frozen exactly when this joiner has
//     stopped RECEIVING snapshots, independent of whether the host's own outbound buffer looks healthy.
//     Once JOINER_MISSED_STREAK consecutive checks see zero tick advancement, this joiner sends a
//     `{type:'relay-request', forTarget: <this joiner's own pubkey>}` control frame: first over its own
//     direct host edge if that data channel still reports `readyState==='open'` (the host may simply be
//     slow to notice the degradation itself, and asking it directly needs no extra hop), or -- only when
//     that direct edge itself looks dead -- broadcast to every other open peer edge as a last resort so
//     ANY joiner still reachable from the host can act as the intermediary. This is deliberately NOT a
//     host-migration election (HostMigration.js's `runElection`, which fires only when the host peer
//     connection fully CLOSES): the host may be alive and well, only this one joiner's path to it is bad,
//     so requesting a relay (not usurping the host role) is the correct, proportionate response. The host
//     side's existing `onPeerSnapshot`-fed `lastSnapshotByPeer` cache (already populated for every peer
//     the host has ever sent a SNAPSHOT to) directly serves this request via the SAME relay/apply
//     machinery `checkOnce`'s bufferedAmount-triggered path already uses -- only the trigger source
//     (an explicit request vs the host's own periodic buffer poll) is new; the wire-frame shape, the
//     relayer-forwarding step, and the joiner-side apply-via-client.onMessage step are all fully reused.
//   - Host side (installSnapshotRelayHost): every peer's raw pre-encoded SNAPSHOT bytes already pass
//     through BrowserServer.js's PEER_SEND handling on their way to `dc.send()` -- this module taps that
//     exact moment (via a caller-supplied onPeerSnapshot hook BrowserServer.js invokes per bare-SNAPSHOT
//     PEER_SEND) and keeps only the MOST RECENT snapshot per peer (bandwidth-bounded, latest-wins, same
//     discipline BrowserServer.js's own rAF-batched snapshot coalescing already uses for the local client).
//     A lightweight liveness loop (every RELAY_CHECK_MS) reads each connected peer's data-channel
//     `bufferedAmount` (a real, already-available RTCDataChannel property -- no new measurement needed) as
//     the "this peer's own host-edge looks unhealthy" signal: a data channel whose outbound buffer isn't
//     draining is evidence packets aren't reaching the peer (or its acks aren't reaching us), the same
//     class of degraded-link symptom the row asks to route around. When a peer crosses the threshold for
//     RELAY_TRIGGER_STREAK consecutive checks, the host picks up to RELAY_FANOUT other peers with an
//     OPEN, non-backed-up data channel and sends each a small `wwrelay:` control frame carrying
//     {type:'relay', forTarget: laggyPeerPubkey, snapshot: <the laggy peer's own latest raw SNAPSHOT
//     bytes as a base64 string -- JSON can't carry raw binary, and this control channel is deliberately
//     the same string-frame convention client/HostMigration.js already established for exactly this
//     reason>}. A relayed snapshot is opt-in and ADDITIVE: the peer's own direct host edge keeps working
//     unmodified the whole time, this is purely a second delivery path for exactly the peers currently
//     showing signs of a lossy direct link.
//   - Joiner side (installSnapshotRelayJoiner): any joiner that receives a `wwrelay:` control frame simply
//     forwards the embedded snapshot bytes on to `forTarget` over its own (already-open, per the mesh
//     probe) data-channel edge to that peer -- one extra hop, zero new connection. The RECEIVING joiner
//     (the one whose direct host link is degraded) listens for a *relayed* SNAPSHOT frame (tagged
//     `wwrelay:` with type:'relayed-snapshot') arriving over ANY peer edge (not just its host edge) and
//     feeds the embedded bytes into the exact same `client.onMessage(bytes)` pipeline a direct host
//     delivery would use -- BaseClient._onSnapshot's own tick-ordering guard (never accept an
//     older-or-equal tick than the last one applied) means an out-of-order or duplicate relay is a
//     harmless no-op, not a correctness risk.
//
// Wire format: three frame shapes over the CONTROL channel (see client/HostMigration.js's header comment
// for why a JSON string frame can never collide with the binary msgpack game protocol):
//   joiner -> host:    {type:'relay-request', forTarget: <requester's own pubkey>}
//   host -> relayer:   {type:'relay', forTarget, snapshotB64}
//   relayer -> target: {type:'relayed-snapshot', snapshotB64}
const CTRL_PREFIX = 'wwrelay:'
function encodeCtrl(obj) { return CTRL_PREFIX + JSON.stringify(obj) }
function decodeCtrl(data) {
  if (typeof data !== 'string' || !data.startsWith(CTRL_PREFIX)) return null
  try { return JSON.parse(data.slice(CTRL_PREFIX.length)) } catch { return null }
}

// btoa/atob operate on binary strings, not raw bytes directly -- this is the standard browser-safe
// ArrayBuffer<->base64 round trip (no external dependency, small enough payloads that chunking isn't
// needed -- a single SNAPSHOT frame is at most a few KB, well under any string-length concern).
function bytesToB64(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}
function b64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const RELAY_CHECK_MS = 2000
// A data channel's outbound buffer that hasn't drained below this across RELAY_TRIGGER_STREAK consecutive
// checks (i.e. ~6s of a real backlog, not one transient spike) is this module's "this peer's direct edge
// looks lossy/degraded" signal -- bufferedAmount is a real, already-available RTCDataChannel property, no
// new measurement/heartbeat needed. 16KB is comfortably above one SNAPSHOT frame's typical size (a few KB)
// so a single normal send never false-triggers it.
const RELAY_BUFFERED_THRESHOLD = 16 * 1024
const RELAY_TRIGGER_STREAK = 3
const RELAY_FANOUT = 2

// Joiner-side missed-snapshot-streak watch (p2p-mesh-joiner-requested-snapshot-relay-on-missed-acks).
// Polled on the same cadence as the host's own bufferedAmount check (RELAY_CHECK_MS) for symmetry, not
// because the two are coupled. A real SNAPSHOT normally arrives many times a second (60Hz tickRate is the
// client default, and the server's own adaptive `_snapshotInterval` -- see src/sdk/TickHandler.js -- only
// ever REDUCES the rate under load, never raises it above tickRate) -- JOINER_MISS_MS is deliberately far
// above any realistic single-interval gap (including a heavily dilated/degraded server) so this can only
// trip on a genuine multi-second delivery outage, not a normal jittery tick. JOINER_MISS_STREAK requires
// that many CONSECUTIVE stalled checks (mirroring RELAY_TRIGGER_STREAK's own consecutive-check discipline
// and HostMigration.js's election-trigger pattern) before requesting a relay, so one slow-but-recovering
// check never false-trips it. JOINER_RELAY_REQUEST_COOLDOWN_MS bounds how often this joiner will re-ask
// once already in a sustained stall (a relay reply -- or the underlying link recovering on its own --
// resets the counters below well before this fires again in the common case).
const JOINER_MISS_MS = 1000
const JOINER_MISS_STREAK = 3
const JOINER_RELAY_REQUEST_COOLDOWN_MS = 5000

// Host-side installer. Call once, right after the host's wireweave bridge + BrowserServer are up (same
// spot client/app.js installs installHostAnnouncer). `getPeerDc(pubkey)` resolves a peer's live data
// channel (client/app.js's host path already keeps this in `bridge.data.peers`). Returns a controller
// exposing `onPeerSnapshot(peerPubkey, bytes)` for BrowserServer.js's PEER_SEND tap to call per-peer, plus
// live-debug state (window.__app.snapshotRelay in client/app.js, mirroring hostMigration's pattern).
export function installSnapshotRelayHost({ bridge }) {
  const lastSnapshotByPeer = new Map() // pubkey -> Uint8Array (latest raw SNAPSHOT bytes sent to that peer)
  const streakByPeer = new Map() // pubkey -> consecutive-degraded-check count
  const stats = { relaysSent: 0, lastRelayAt: 0, degradedPeers: [] }

  function onPeerSnapshot(peerPubkey, bytes) {
    lastSnapshotByPeer.set(peerPubkey, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  }

  function healthyRelayCandidates(excludePubkey) {
    const out = []
    for (const [pk, peer] of bridge.data.peers) {
      if (pk === excludePubkey) continue
      const dc = peer?.dc
      if (dc?.readyState === 'open' && (dc.bufferedAmount || 0) < RELAY_BUFFERED_THRESHOLD) out.push(pk)
    }
    return out
  }

  // Shared relay-trigger, reused by both this file's own bufferedAmount-driven `checkOnce` poll AND a
  // joiner's explicit `relay-request` control frame (see installSnapshotRelayJoiner below) -- only the
  // TRIGGER SOURCE differs, the actual relay mechanics (pick healthy relayers, fan out the target's
  // latest cached snapshot) are identical either way, so both paths share this one function rather than
  // duplicating the relay-send logic.
  function triggerRelay(target) {
    const snap = lastSnapshotByPeer.get(target)
    if (!snap || !snap.length) return false
    const relayers = healthyRelayCandidates(target).slice(0, RELAY_FANOUT)
    if (!relayers.length) return false
    const payload = encodeCtrl({ type: 'relay', forTarget: target, snapshotB64: bytesToB64(snap) })
    for (const rp of relayers) bridge.data.send(rp, payload)
    stats.relaysSent += relayers.length
    stats.lastRelayAt = Date.now()
    return true
  }

  function checkOnce() {
    const degraded = []
    for (const [pk, peer] of bridge.data.peers) {
      const dc = peer?.dc
      if (!dc || dc.readyState !== 'open') { streakByPeer.delete(pk); continue }
      const buffered = dc.bufferedAmount || 0
      if (buffered >= RELAY_BUFFERED_THRESHOLD) {
        const streak = (streakByPeer.get(pk) || 0) + 1
        streakByPeer.set(pk, streak)
        if (streak >= RELAY_TRIGGER_STREAK) degraded.push(pk)
      } else {
        streakByPeer.delete(pk)
      }
    }
    stats.degradedPeers = degraded
    for (const target of degraded) triggerRelay(target)
  }

  const iv = setInterval(checkOnce, RELAY_CHECK_MS)

  // Joiner-requested trigger (p2p-mesh-joiner-requested-snapshot-relay-on-missed-acks): a joiner whose
  // OWN missed-snapshot streak crossed its threshold (see installSnapshotRelayJoiner) asks to be relayed
  // NOW, rather than waiting for the host's own bufferedAmount poll to notice (which, per the file
  // header, can miss a one-way-lossy path that never backs up the host's outbound buffer at all). This
  // can arrive two ways: DIRECTLY from the requesting peer itself (the common case -- its own edge to the
  // host is fine, only its ability to RECEIVE is degraded) where `detail.peerPubkey === msg.forTarget`,
  // or FORWARDED by an intermediate joiner (the "direct host edge itself looks dead" fallback -- see
  // installSnapshotRelayJoiner's forward branch) where `detail.peerPubkey` is the FORWARDER, not the
  // original requester. `msg.forTarget` (not `detail.peerPubkey`) is therefore always the real
  // relay-target identity in both cases. This does not open a spoofing hole: triggerRelay only ever acts
  // if the host itself already has a cached SNAPSHOT it legitimately sent to `forTarget` (populated
  // exclusively by this host's own onPeerSnapshot tap, never by anything peer-supplied), and the host
  // independently picks which OTHER peers relay it (healthyRelayCandidates) -- a forged forTarget can at
  // worst make the host needlessly re-relay a real peer's own already-being-sent snapshot, never redirect
  // one peer's private data to an unintended destination or leak anything not already being sent to them.
  bridge.data.addEventListener('data', ({ detail }) => {
    const msg = decodeCtrl(detail.data)
    if (!msg || msg.type !== 'relay-request' || !msg.forTarget) return
    triggerRelay(msg.forTarget)
  })

  return {
    onPeerSnapshot,
    getStats() { return { ...stats, degradedPeers: [...stats.degradedPeers] } },
    stop() { clearInterval(iv) }
  }
}

// Joiner-side installer. Call once, right after a joiner's WireweaveJoinClient.connect() resolves (same
// spot client/app.js installs installHostMigration). `getClient` is a THUNK, not a captured instance --
// client/app.js's module-level `client` binding is reassigned in place if this joiner later wins a
// host-migration election (client/HostMigration.js's becomeNewHost), so a captured reference would apply
// a relayed snapshot to a now-permanently-inert old WireweaveJoinClient instead of the live one; a getter
// re-reads the current binding on every relay delivery instead. `bridge` is the wireweave bridge.
// Listens broadly across every peer edge (mirroring HostMigration.js's own listener discipline) since a
// relay can legitimately arrive from ANY other joiner in the mesh, not a fixed one. Returns live-debug
// state (window.__app.snapshotRelay in client/app.js).
export function installSnapshotRelayJoiner({ getClient, bridge }) {
  const stats = { relayedForwarded: 0, relayedApplied: 0, lastAppliedAt: 0, missStreak: 0, relayRequestsSent: 0, lastRelayRequestAt: 0 }
  let lastSeenTick = -1
  let lastRelayRequestAt = 0

  // Sends this joiner's own relay-request: over its own direct host edge first if that channel is still
  // reporting `readyState==='open'` (the cheapest path, and covers "host is fine, just hasn't noticed
  // this one degraded link yet"), falling back to a broadcast over every other open peer edge only when
  // the direct host edge itself looks dead (matching the row's own "or broadcasts ... as a last resort"
  // scope) -- some other mesh-connected joiner may still have a healthy path to the host and can carry
  // the request the rest of the way, mirroring how HostMigration.js already treats the mesh as
  // fully-connected-in-general rather than assuming any single edge.
  function sendRelayRequest() {
    const client = getClient()
    const myPubkey = bridge.pubkey
    if (!myPubkey) return
    const payload = encodeCtrl({ type: 'relay-request', forTarget: myPubkey })
    const hostPubkey = client?._hostPubkey
    const hostDc = hostPubkey ? bridge.data.peers.get(hostPubkey)?.dc : null
    if (hostDc?.readyState === 'open') {
      bridge.data.send(hostPubkey, payload)
    } else {
      for (const [pk, peer] of bridge.data.peers) {
        if (pk === myPubkey || pk === hostPubkey) continue
        if (peer?.dc?.readyState === 'open') bridge.data.send(pk, payload)
      }
    }
    stats.relayRequestsSent++
    stats.lastRelayRequestAt = lastRelayRequestAt = Date.now()
  }

  function checkMissedSnapshots() {
    const client = getClient()
    // Nothing to watch once this joiner has migrated into being the host itself (see the header comment
    // on the 'relayed-snapshot' apply branch below for why a _worker-backed client is a different shape
    // entirely) -- a host builds its own snapshots and never "misses" one from itself.
    if (!client || client._worker) { lastSeenTick = -1; stats.missStreak = 0; return }
    const tick = client.currentTick || 0
    if (tick !== lastSeenTick) {
      lastSeenTick = tick
      stats.missStreak = 0
      return
    }
    const streak = stats.missStreak + 1
    stats.missStreak = streak
    if (streak >= JOINER_MISS_STREAK && Date.now() - lastRelayRequestAt >= JOINER_RELAY_REQUEST_COOLDOWN_MS) {
      sendRelayRequest()
    }
  }

  const missIv = setInterval(checkMissedSnapshots, JOINER_MISS_MS)

  bridge.data.addEventListener('data', ({ detail }) => {
    const msg = decodeCtrl(detail.data)
    if (!msg) return
    // Broadcast-fallback forward (see sendRelayRequest's "last resort" branch above): a peer that hears a
    // relay-request NOT addressed as a direct send to the host (i.e. it arrived here, at an ordinary
    // joiner, because the ORIGINAL sender's own direct host edge looked dead) forwards it on to the peer
    // THIS joiner itself currently considers the host, over its OWN edge -- which is exactly the "some
    // other mesh-connected joiner may still have a healthy path to the host" case this fallback exists
    // for. A joiner forwards only once per received frame (no further re-broadcast chaining, since every
    // participant that received the original broadcast independently attempts this same single hop,
    // which is sufficient given the mesh's own all-pairs-connected topology -- HostMigration.js's file
    // header -- and avoids an unbounded flood if multiple joiners are all mid-fallback simultaneously).
    // A request for THIS peer's own identity (forTarget === bridge.pubkey) is not forwarded -- that shape
    // only makes sense addressed directly to the actual host, which handles it in installSnapshotRelayHost.
    if (msg.type === 'relay-request' && msg.forTarget && msg.forTarget !== bridge.pubkey) {
      const client = getClient()
      const hostPubkey = client?._hostPubkey
      if (!hostPubkey || hostPubkey === detail.peerPubkey) return // no known host, or the sender WAS already the host (shouldn't happen -- host handles its own listener) -- nothing useful to forward
      const dc = bridge.data.peers.get(hostPubkey)?.dc
      if (dc?.readyState === 'open') bridge.data.send(hostPubkey, encodeCtrl(msg))
      return
    }
    if (msg.type === 'relay' && msg.forTarget && msg.snapshotB64) {
      // We were asked to forward this to `forTarget` -- only meaningful if we ourselves are NOT the
      // target (a relay-to-self would be a host bug, defensively ignored) and we actually have an open
      // edge to that peer (per the mesh probe this should always be true, but never assume).
      if (msg.forTarget === bridge.pubkey) return
      const dc = bridge.data.peers.get(msg.forTarget)?.dc
      if (!dc || dc.readyState !== 'open') return
      dc.send(encodeCtrl({ type: 'relayed-snapshot', snapshotB64: msg.snapshotB64 }))
      stats.relayedForwarded++
      return
    }
    if (msg.type === 'relayed-snapshot' && msg.snapshotB64) {
      // A migration-elected new host (see the file header) is no longer a WireweaveJoinClient at all --
      // client.onMessage doesn't exist on a BrowserServer's own peer-transport path the same way, and
      // applying a stale relay post-migration would be meaningless anyway (a host builds its own
      // snapshots). Skip cleanly rather than throw.
      const client = getClient()
      if (!client || typeof client.onMessage !== 'function' || client._worker) return
      try {
        const bytes = b64ToBytes(msg.snapshotB64)
        client.onMessage(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
        stats.relayedApplied++
        stats.lastAppliedAt = Date.now()
      } catch (e) { console.warn('[SnapshotRelay] failed to apply relayed snapshot:', e?.message || e) }
    }
  })

  return {
    getStats() { return { ...stats } },
    stop() { clearInterval(missIv) }
  }
}

export const _test = { encodeCtrl, decodeCtrl, bytesToB64, b64ToBytes, RELAY_BUFFERED_THRESHOLD, RELAY_TRIGGER_STREAK, RELAY_FANOUT, JOINER_MISS_MS, JOINER_MISS_STREAK, JOINER_RELAY_REQUEST_COOLDOWN_MS }
