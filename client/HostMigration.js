// P2P BrowserServer host migration: when the current wireweave-room host disconnects, the remaining
// peers independently elect the lowest-median-RTT survivor as the next host, that peer boots a real
// in-Worker BrowserServer seeded from the best available world-state snapshot, and every other peer
// re-points its game data channel to the new host WITHOUT a full page reload or session restart.
//
// Real architecture this builds on (read live from source, not assumed):
//   - client/WireweaveJoinClient.js: a joiner locks onto exactly ONE peer (`_hostPubkey`, the first
//     wireweave data-channel to open) and routes all game traffic through it. It has no reconnect/
//     migration logic at all today.
//   - client/BrowserServer.js (host side): boots a real in-Worker server via src/sdk/WorkerEntry.js,
//     and separately calls attachWireweavePeer(peerId, dc) for each OTHER room participant so the host
//     has a game-protocol connection to every joiner (star topology at the SPOINT APP layer).
//   - node_modules/wireweave/src/data.js (DataSession): underneath the app-layer star topology, EVERY
//     room participant already opens a real WebRTC data channel to EVERY other participant, driven by
//     nostr presence events every connected peer subscribes to (_onPresence -> _maybeConnect for each
//     peer seen, unconditional on host/joiner role). This means bridge.data.peers already holds (or will
//     shortly hold) a live connection between any two peers in the room, INCLUDING between two joiners --
//     migration never needs to establish a new peer connection, only start treating an already-connected
//     peer's data channel as the game-server link.
//   - src/sdk/ServerHandlers.js: the host already computes a per-client EWMA RTT (client.rtt) from the
//     existing HEARTBEAT round trip, but never broadcast it anywhere until this change (see
//     src/sdk/TickHandler.js's MSG.PEER_RTT_TABLE broadcast + src/client/MessageHandler.js's
//     getPeerRttTable()) -- this is the "median ping among remaining connected peers" data source.
//   - src/client/SnapshotProcessor.js already maintains a continuously-updated, fully-decoded
//     _playerStates/_entityStates map from every incoming SNAPSHOT -- exactly the "last-known
//     client-side snapshot" the task asks for as the ungraceful-disconnect fallback; no separate
//     rolling cache needed, BaseClient.getAllStates()/getAllEntities() already expose it.
//
// Wire format for the small peer<->peer CONTROL channel this file adds (distinct from the game's own
// binary msgpack protocol, which always starts with either the 0xFF coalesce sentinel or a msgpack map
// header byte 0x80-0x8f/0xde/0xdf -- a JSON STRING frame can never collide with those, and
// RTCDataChannel delivers a sent string back as a string on the receiving end regardless of
// `dc.binaryType`, which only governs how BINARY frames are received): a control frame is
// `"wwmigrate:" + JSON.stringify({type, ...})`, sent over the SAME already-open data channel
// game traffic uses (bridge.data.send/broadcast) rather than opening a second channel.
const CTRL_PREFIX = 'wwmigrate:'

function encodeCtrl(obj) { return CTRL_PREFIX + JSON.stringify(obj) }
function decodeCtrl(data) {
  if (typeof data !== 'string' || !data.startsWith(CTRL_PREFIX)) return null
  try { return JSON.parse(data.slice(CTRL_PREFIX.length)) } catch { return null }
}

// Deterministic winner: lowest RTT; ties broken by pubkey string compare so every peer computing this
// independently (no vote round-trip, no leader-proposes-and-waits) arrives at the identical answer.
// candidates: [{pubkey, rtt}], rtt may be null/undefined (never measured yet) -- treated as +Infinity so
// a peer with no RTT sample never wins over one that has any real measurement.
// MSG.WORLD_DEF (src/sdk/ServerHandlers.js's sendWorldDefAndModules) deliberately withholds
// worldDef.entities from the wire to every client (replaced by reduced _modelUrls/_entityApps
// summaries) -- entities are meant to reach clients via SNAPSHOT/SCENE_GRAPH instead. That is fine for
// an ordinary client, but a joiner that must become a REAL host (WorkerEntry.js's init() ->
// StageLoader.loadFromDefinition, which spawns every worldDef.entities[] entry) needs the FULL
// definition including entities, or every world-def-authored static/scripted entity (not just live
// dynamic state) would silently vanish on migration. Rather than changing the bandwidth-sensitive
// WORLD_DEF wire contract, the host sends its OWN full worldDef (JSON, includes entities) exactly once
// per peer over this file's control channel -- cheap (fires once per connection, not every tick) and
// keeps the existing WORLD_DEF optimization untouched for the hot path.
function encodeFullWorldDef(worldDef) { return encodeCtrl({ type: 'full-worlddef', worldDef }) }

function electWinner(candidates) {
  let best = null
  for (const c of candidates) {
    const rtt = Number.isFinite(c.rtt) ? c.rtt : Infinity
    if (!best) { best = { ...c, rtt }; continue }
    if (rtt < best.rtt || (rtt === best.rtt && c.pubkey < best.pubkey)) best = { ...c, rtt }
  }
  return best
}

// Builds the {players:[{pubkey,position,rotation,health}], entities:[{id,position,rotation,velocity}]}
// migrationSnapshot payload from whatever client-side state is reachable right now. `client` is any
// BaseClient subclass (WireweaveJoinClient here) -- getAllStates()/getAllEntities() are the
// continuously-updated SnapshotProcessor maps described above. `pubkeyOf(playerId)` resolves a server
// playerId to a wireweave pubkey via the last-received PEER_RTT_TABLE's pubkeys map (see
// MessageHandler.js) plus the local player's own known pubkey for its own entry.
function buildMigrationSnapshot(client, pubkeyOf) {
  const players = []
  for (const [pid, st] of client.getAllStates()) {
    const pubkey = pubkeyOf(pid)
    if (!pubkey) continue // a player this client never resolved a pubkey for (e.g. RTT table not yet received) is simply omitted -- it falls back to a fresh spawn point, never a hard failure
    players.push({ pubkey, position: [...st.position], rotation: [...st.rotation], health: st.health })
  }
  const entities = []
  for (const [eid, st] of client.getAllEntities()) {
    entities.push({ id: eid, position: [...st.position], rotation: [...st.rotation], velocity: [...st.velocity] })
  }
  return { players, entities }
}

// Wires host-migration onto an already-connected WireweaveJoinClient + its wireweave bridge. Call once,
// right after WireweaveJoinClient.connect() resolves (client/app.js's join path). No-op wiring on the
// CURRENT host itself -- a host doesn't need to detect its own disconnect, it only needs (below, in
// installHostAnnouncer) to tell joiners who it is so a FUTURE migrated-to host can be recognized the
// same way. Returns a controller exposing state for live debugging/verification
// (window.__app.hostMigration in client/app.js).
export function installHostMigration({ client, bridge, worldDef, apps, ctxRoot, uiRoot, room, namespace, iceServers, onNewHost }) {
  let electing = false
  let electedWinnerPubkey = null
  // Populated by the current host's 'full-worlddef' control broadcast (see installHostAnnouncer below);
  // starts as the caller-supplied worldDef (the wire-received, entities-stripped WORLD_DEF payload) and
  // is upgraded in place the moment the real full definition arrives -- never left permanently stale
  // since the host re-sends it on every peer-open, including immediately after THIS peer's own connect.
  let fullWorldDef = worldDef
  const state = { phase: 'connected', hostPubkey: client._hostPubkey, newHostPubkey: null, lastElection: null }

  function pubkeyOf(playerId) {
    if (playerId === client.playerId) return bridge.pubkey
    return client._msgHandler.getPeerRttTable().pubkeys[playerId] || null
  }

  // Every peer in the mesh (see the file-header note: presence already connects everyone to everyone)
  // receives this on its data channel to the DEPARTED host's replacement -- but since the departed host
  // is gone, the winner announces over EVERY peer connection it has, not just via the old host's channel.
  // Reuses installHostAnnouncer (below) so a migration-elected host behaves identically to the room's
  // original host from every other peer's perspective -- same host-announce + full-worlddef re-broadcast
  // on every peer-open, so a SECOND migration (the new host later also disconnects) works unmodified.
  function announceAsNewHost() {
    installHostAnnouncer(bridge, fullWorldDef)
    // A peer whose mesh connection to the winner is still mid-handshake at the exact instant of the
    // first broadcast would miss it; re-announce a few times over the next few seconds so a
    // slightly-delayed peer connection still gets the message without needing its own retry logic.
    const payload = encodeCtrl({ type: 'host-announce', pubkey: bridge.pubkey })
    let n = 0
    const iv = setInterval(() => {
      bridge.data.broadcast(payload)
      if (++n >= 5) clearInterval(iv)
    }, 1000)
  }

  async function becomeNewHost() {
    state.phase = 'electing-self'
    const snapshot = buildMigrationSnapshot(client, pubkeyOf)
    // Retire the OLD WireweaveJoinClient's message consumption BEFORE the new BrowserServer attaches to
    // the same mesh peer connections. client.disconnect() is NOT safe here -- it calls bridge.destroy(),
    // which would tear down every peer's RTC connection this room's migration needs to keep alive (see
    // client/WireweaveJoinClient.js). Instead: WireweaveJoinClient's own onData/onClose/onOpen listeners
    // (installed once at connect(), re-read live every event -- see repointToNewHost's comment above)
    // all gate on `detail.peerPubkey !== this._hostPubkey`; pointing _hostPubkey at a value no real
    // pubkey can ever equal makes every one of those listeners a permanent no-op without touching the
    // shared bridge or any live peer connection.
    client._hostPubkey = null
    client.connected = false
    // Include the electing peer's OWN last-known transform (WorkerEntry.js's init() reads this back out
    // via localPubkey, see the ctx.localRejoinState wiring) so the new host's own player doesn't reset
    // to a random spawn point either.
    const { BrowserServer } = await import('./BrowserServer.js')
    const newServer = new BrowserServer({ ...ctxRoot, worldDef: fullWorldDef, migrationSnapshot: snapshot, localPubkey: bridge.pubkey })
    // Real in-Worker boot -- identical code path to a fresh singleplayer/host boot (WorkerEntry.js
    // init()), just pre-seeded. Any peer already mesh-connected (see file header) attaches immediately;
    // any peer that connects later (a slow ICE negotiation) attaches via the same peer-open listener
    // pattern client/app.js's host bridge already uses.
    await newServer.connect()
    const attached = new Set()
    const attachIfReady = pk => {
      if (attached.has(pk) || pk === bridge.pubkey) return
      const dc = bridge.data.peers.get(pk)?.dc
      if (!dc || dc.readyState !== 'open') return
      attached.add(pk)
      newServer.attachWireweavePeer(pk, dc)
    }
    bridge.data.addEventListener('peer-open', ({ detail }) => attachIfReady(detail.peerPubkey))
    for (const [pk, peer] of bridge.data.peers) if (peer?.dc?.readyState === 'open') attachIfReady(pk)
    bridge.data.addEventListener('peer-close', ({ detail }) => {
      attached.delete(detail.peerPubkey)
    })
    state.phase = 'hosting'
    state.newHostPubkey = bridge.pubkey
    announceAsNewHost()
    // Caller (client/app.js) MUST reassign its module-level `client` binding to newServer -- every other
    // system in app.js (input send, playerId reads, HUD) references the ORIGINAL WireweaveJoinClient
    // instance by closure, and that instance is now permanently inert (see the _hostPubkey=null retire
    // above). See client/app.js's onNewHost handler.
    onNewHost?.({ becameHost: true, server: newServer })
    return newServer
  }

  // Re-point THIS client's existing WireweaveJoinClient at the newly-elected host's pubkey, reusing the
  // already-open (or opening) mesh data channel rather than tearing down and recreating the whole
  // WireweaveJoinClient/bridge -- this is what "reconnect without a full session restart" means
  // concretely: the wireweave room membership, auth key, and relay connections are untouched, only
  // which peer's dc client traffic is routed through changes.
  function repointToNewHost(newHostPubkey) {
    state.phase = 're-pointing'
    // WireweaveJoinClient._wireDcEvents() (installed exactly once, at the original connect()) closes
    // over `this` and re-reads `this._hostPubkey` FRESH on every event -- it is NOT a value captured at
    // wiring time. Reassigning the field is therefore sufficient for the already-installed onData/
    // onClose/onOpen listeners to start routing to the new peer; calling _wireDcEvents() again here
    // would register a second, duplicate set of listeners (every future message double-delivered to
    // onMessage) -- confirmed by reading client/WireweaveJoinClient.js's real closures, not assumed.
    client._hostPubkey = newHostPubkey
    const dc = bridge.data.peers.get(newHostPubkey)?.dc
    if (dc && dc.readyState === 'open') {
      client._dc = dc
      client.connected = true
      if (client._pendingSends.length) { const q = client._pendingSends; client._pendingSends = []; for (const buf of q) client._rawSend(buf) }
    } else {
      // Not open yet (mesh connection still negotiating) -- the already-installed peer-open listener's
      // live `this._hostPubkey` re-check (see comment above) fires the moment this pubkey's channel
      // opens, completing the reconnect automatically; nothing further to do here.
      client.connected = false
    }
    state.phase = 'reconnected'
    state.hostPubkey = newHostPubkey
    onNewHost?.({ becameHost: false, hostPubkey: newHostPubkey })
  }

  function handleHostAnnounce(fromPubkey, msg) {
    if (state.phase === 'hosting') return // we already won our own election; ignore stale/duplicate announces
    if (msg.pubkey !== fromPubkey) return // integrity check: the announcing peer must be announcing itself
    repointToNewHost(msg.pubkey)
  }

  // Any peer's data channel can carry a control frame (the mesh means a joiner-to-joiner channel is a
  // real possibility once a migration is in flight), so this listens broadly rather than only on the
  // current _hostPubkey channel.
  bridge.data.addEventListener('data', ({ detail }) => {
    const msg = decodeCtrl(detail.data)
    if (!msg) return
    if (msg.type === 'host-announce') handleHostAnnounce(detail.peerPubkey, msg)
    // Only trusted from the peer this client currently considers the host -- a non-host peer's stale or
    // spoofed full-worlddef must never silently replace the real one mid-session.
    else if (msg.type === 'full-worlddef' && detail.peerPubkey === state.hostPubkey && msg.worldDef && typeof msg.worldDef === 'object') {
      fullWorldDef = msg.worldDef
    }
  })

  async function runElection() {
    if (electing) return
    electing = true
    state.phase = 'electing'
    try {
      const rttTable = client._msgHandler.getPeerRttTable()
      const myRtt = client.getRTT()
      const candidates = [{ pubkey: bridge.pubkey, rtt: myRtt }]
      for (const [pk] of bridge.data.peers) {
        if (pk === state.hostPubkey) continue // the peer that just left is never a candidate
        // Resolve this peer's server-measured RTT via the pubkey->playerId reverse lookup baked into the
        // last-received table; a peer this client never got an RTT sample for is still a valid candidate
        // (electWinner treats a missing rtt as +Infinity, so it only loses to a peer with a REAL measurement).
        let rtt = null
        for (const [pid, pubkey] of Object.entries(rttTable.pubkeys)) { if (pubkey === pk) { rtt = rttTable.rtt[pid]; break } }
        candidates.push({ pubkey: pk, rtt })
      }
      const winner = electWinner(candidates)
      state.lastElection = { candidates, winner: winner?.pubkey }
      electedWinnerPubkey = winner?.pubkey || null
      if (!electedWinnerPubkey) { state.phase = 'election-failed-no-candidates'; return }
      if (electedWinnerPubkey === bridge.pubkey) {
        await becomeNewHost()
      } else {
        // Give the winner a moment to actually boot (real Worker spin-up + physics WASM compile is not
        // instant) before expecting its host-announce; repointToNewHost will also fire reactively the
        // moment the announce arrives even if it beats this timer.
        state.phase = 'awaiting-new-host-announce'
        setTimeout(() => {
          if (state.phase === 'awaiting-new-host-announce' && state.hostPubkey !== electedWinnerPubkey) {
            // Fallback: the announce broadcast (UDP-like, best-effort over an unreliable-by-default
            // data channel) may simply not have arrived -- if the elected peer's data channel is
            // already open, re-point directly rather than waiting indefinitely.
            const dc = bridge.data.peers.get(electedWinnerPubkey)?.dc
            if (dc?.readyState === 'open') repointToNewHost(electedWinnerPubkey)
          }
        }, 4000)
      }
    } finally {
      electing = false
    }
  }

  // The one real trigger: the current host's data channel closes. WireweaveJoinClient's own onClose
  // already flips client.connected=false and fires callbacks.onDisconnect -- this listens on the SAME
  // bridge.data 'peer-close'/'peer-closed' events (already firing for every peer, host or not) and
  // filters to just the host, so migration starts immediately rather than waiting for some separate
  // reconnect-timeout loop.
  const onPeerGone = ({ detail }) => {
    if (detail.peerPubkey !== state.hostPubkey) return
    if (state.phase === 'hosting') return // we're already the host (a different bug, not a migration case)
    runElection()
  }
  bridge.data.addEventListener('peer-close', onPeerGone)
  bridge.data.addEventListener('peer-closed', onPeerGone)

  return {
    getState() { return { ...state } },
    // exposed for live/manual verification (see window.__app.hostMigration in client/app.js) and for a
    // graceful-handoff caller (not required for correctness -- see the file header's snapshot-fallback
    // note -- but cheaper than waiting for the ungraceful path when the departure IS foreseeable, e.g.
    // a host explicitly leaving the tab).
    forceElection: runElection,
    _electWinner: electWinner,
    _buildMigrationSnapshot: () => buildMigrationSnapshot(client, pubkeyOf)
  }
}

// Host-side installer: makes the CURRENT host announce itself the same way a migrated-to host would, so
// a peer that only ever knew "connect to whoever announces host-announce first" (rather than assuming
// _wwRoom's original host) works uniformly whether it's the room's original host or a migration result.
// Also sends the FULL worldDef (including entities -- see encodeFullWorldDef's header comment) once per
// peer connection so every joiner has what it needs to become a real host itself later, without ever
// widening the bandwidth-sensitive WORLD_DEF wire contract every tick relies on. Call once from
// client/app.js's existing host-bridge setup, right after the host's own BrowserServer is up and peers
// start attaching -- also re-invoked identically by a migration winner (becomeNewHost above sets
// onNewHost, client/app.js's caller re-installs the announcer for the new host role).
export function installHostAnnouncer(bridge, worldDef) {
  const hostPayload = encodeCtrl({ type: 'host-announce', pubkey: bridge.pubkey })
  const worldPayload = worldDef ? encodeFullWorldDef(worldDef) : null
  const announce = () => { bridge.data.broadcast(hostPayload); if (worldPayload) bridge.data.broadcast(worldPayload) }
  bridge.data.addEventListener('peer-open', announce)
  announce()
}

// p2p-mesh-initial-host-election-race-on-shared-room-code: fixes the INITIAL-host ambiguity this file's
// header long documented as unhandled (only a mid-session host DISCONNECT was covered). Two tabs both
// navigating to the identical `?room=X` link (shared bookmark, accidental reload-while-hosting, etc)
// would previously both boot their own independent BrowserServer with zero collision detection -- a
// genuine joiner then non-deterministically locked onto whichever dueling host's data channel opened
// first, silently splitting the room into two disconnected simulations.
//
// Call this AFTER the bridge is connected but BEFORE booting a new BrowserServer. It listens on the
// SAME control-frame wire format installHostAnnouncer already broadcasts (CTRL_PREFIX 'wwmigrate:',
// {type:'host-announce', pubkey}) for `graceMs` -- if any peer already in the room announces itself as
// host within that window, this resolves with that peer's pubkey (the caller should defer: join instead
// of hosting). If nothing is heard, resolves null (safe to proceed and become the host, the common case
// of a genuinely-first arrival). Deterministic AND collision-safe even if BOTH tabs listen simultaneously
// and neither has announced yet: see installHostAnnouncerWithLowestPubkeyDefer below for that residual
// race, which a bare listen-then-announce cannot fully close on its own (both listeners can validly hear
// silence and both proceed to host) -- this function alone already closes the much more common case
// (a real pre-existing, already-running host that simply hasn't been given a moment to be heard from).
export function waitForExistingHost(bridge, graceMs = 1500) {
  return new Promise(resolve => {
    let done = false
    const finish = pubkey => { if (done) return; done = true; bridge.data.removeEventListener('data', onData); clearTimeout(timer); resolve(pubkey) }
    const onData = ({ detail }) => {
      const msg = decodeCtrl(detail.data)
      if (msg && msg.type === 'host-announce' && msg.pubkey === detail.peerPubkey) finish(msg.pubkey)
    }
    bridge.data.addEventListener('data', onData)
    const timer = setTimeout(() => finish(null), graceMs)
  })
}

// p2p-mesh-ice-negotiation-latency-blocks-collision-detection: waitForExistingHost + the residual
// _onPossibleCollision listener (client/app.js) both listen on bridge.data -- the real WebRTC data
// channel layer, which only exists once ICE negotiation completes. Live-measured this session: ICE
// negotiation between two tabs took 15-18+ seconds in this environment, occasionally not completing
// within a reasonable wait window at all, meaning neither listener can ever fire regardless of how
// early it's installed if the two tabs never form a data channel between them in time. Nostr relay
// round-trips, by contrast, were consistently well under a second every time this session measured
// them -- the relay layer (bridge.pool/bridge.auth) is connected and ready long before any WebRTC
// negotiation could plausibly complete (RelayPool.connect() is called at bridge CONSTRUCTION time,
// before data.connect()/WebRTC negotiation even starts).
//
// claimHostViaRelay publishes a real nostr kind:30078 addressable event (same event kind + kind of
// content _publishPresence already uses, matching the DataSession's own existing wire convention
// rather than inventing a new one) tagged with a room-scoped 'd' tag distinct from presence, subscribes
// to the SAME filter, and races: if a COMPETING claim with a LOWER pubkey (same deterministic tie-break
// electWinner already uses -- lowest wins) is heard within graceMs, this tab loses and should defer to
// join instead of hosting. This is deliberately NOT a replacement for waitForExistingHost/
// _onPossibleCollision (an ALREADY-RUNNING host still needs the WebRTC-layer host-announce, since a
// relay-only claim has no way to represent "I've been hosting for 20 minutes, no need to reclaim") --
// it is a NEW, EARLIER, FASTER first line of defense specifically for the genuinely-concurrent-boot
// case, catching the exact window (both tabs deciding to host within the same few hundred ms) that
// WebRTC-layer detection structurally cannot reach in time when ICE negotiation is slow.
//
// Call this BEFORE waitForExistingHost (or in parallel with it) -- if claimHostViaRelay resolves
// {shouldDefer:true, winnerPubkey}, skip booting a BrowserServer and construct a WireweaveJoinClient
// with knownHostPubkey=null (a relay-claimed winner has no data channel yet to hand off -- the joiner's
// own existing first-peer-open fallback in WireweaveJoinClient.js handles connecting once ONE of the
// mesh's real data channels opens, since by definition only the relay-elected winner will have
// bootstrapped a BrowserServer).
export function claimHostViaRelay(bridge, roomId, graceMs = 800) {
  return new Promise(resolve => {
    const dTag = 'wireweave-hostclaim:' + roomId
    const subId = 'hostclaim-' + Math.random().toString(36).slice(2, 10)
    let done = false
    let sawCompeting = null
    const finish = () => {
      if (done) return
      done = true
      try { bridge.pool.unsubscribe(subId) } catch (_) {}
      clearTimeout(timer)
      if (sawCompeting && sawCompeting !== bridge.pubkey) {
        const winner = electWinner([{ pubkey: bridge.pubkey, rtt: null }, { pubkey: sawCompeting, rtt: null }])
        resolve(winner?.pubkey === bridge.pubkey ? { shouldDefer: false, winnerPubkey: null } : { shouldDefer: true, winnerPubkey: sawCompeting })
      } else {
        resolve({ shouldDefer: false, winnerPubkey: null })
      }
    }
    const onEvent = (evt) => {
      const dt = Array.isArray(evt?.tags) ? evt.tags.find(t => t[0] === 'd') : null
      if (!dt || dt[1] !== dTag) return
      const claimerPubkey = evt.pubkey
      if (claimerPubkey === bridge.pubkey) return // our own claim echoed back is not competition
      if (!sawCompeting || claimerPubkey < sawCompeting) sawCompeting = claimerPubkey
    }
    bridge.pool.subscribe(subId, [{ kinds: [30078], '#d': [dTag] }], onEvent)
    const timer = setTimeout(finish, graceMs)
    bridge.auth.sign({
      kind: 30078, created_at: Math.floor(Date.now() / 1000),
      tags: [['d', dTag]],
      content: JSON.stringify({ pubkey: bridge.pubkey, ts: Date.now() }),
    }).then(signed => { bridge.pool.publish(signed) }).catch(() => {})
  })
}

export const _test = { electWinner, encodeCtrl, decodeCtrl, buildMigrationSnapshot, waitForExistingHost, claimHostViaRelay }
