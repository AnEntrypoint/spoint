import { MSG, DISCONNECT_REASONS, WIRE_PROTOCOL_VERSION } from '../protocol/MessageTypes.js'
import { WIRE_STRUCT_HASH, unpack, pack } from '../protocol/msgpack.js'
import { SnapshotEncoder } from '../netcode/SnapshotEncoder.js'
import { createEditorHandlers } from './EditorHandlers.js'
import { timingSafeTokenEqual } from './authCompare.js'
import { isInputRateLimited, clearInputBucket, sanitizeInputPayload } from '../netcode/InputGuard.js'
import { clearOutlierWindow } from '../netcode/OutlierDetector.js'
import { createNostrAuthServer } from './NostrAuthServer.js'

// A world-authored spawnPoint (worldDef.spawnPoint/spawnPoints) is a maker-chosen XZ with a guessed Y --
// real ground height at that XZ can differ from the guess (e.g. a raised arena floor section), spawning
// the player embedded in geometry. Ray down from well above the point and use the actual hit height
// (+ a small clearance) when physics is available and the ray finds ground; otherwise keep the authored
// point as-is (unraycastable dedicated-Node/no-collider case degrades to prior behavior, not a crash).
function groundSnapSpawnPoint(ctx, sp) {
  if (!ctx.physics || typeof ctx.physics.raycast !== 'function') return sp
  const hit = ctx.physics.raycast([sp[0], sp[1] + 20, sp[2]], [0, -1, 0], 40)
  if (hit && hit.hit && Number.isFinite(hit.position?.[1])) return [sp[0], hit.position[1] + 2, sp[2]]
  return sp
}

export function createConnectionHandlers(ctx) {
  const { tickSystem, playerManager, networkState, lagCompensator, physicsIntegration, connections, sessions, appLoader, appRuntime, emitter, inspector } = ctx
  // Undefined on the real multiplayer server.js path (no ring there) and whenever the singleplayer
  // ring is unavailable (see TransformRing.js's isRingAvailable) -- every call below is optional-chained,
  // never assumed present. release() is idempotent for an unknown/already-released playerId (no-op).
  const transformRingWriter = ctx.transformRingWriter || null
  const editorHandlers = createEditorHandlers(ctx)
  // playerId -> wireweave nostr pubkey. Populated by a client-sent APP_EVENT{type:'voice_identity',pubkey}
  // once its VoiceSession connects (client/hud/VoiceIndicator.js). This is the ONLY link between a
  // VoiceSession peer key (a nostr pubkey) and a game player.id (pm.playerMeshes key) -- without it,
  // proximity-attenuated voice has no way to find a remote speaker's world position. Deliberately routed
  // through the existing bidirectional APP_EVENT channel (see src/client/BaseClient.js's sendEmote/sendLaunch
  // for the established client->server APP_EVENT precedent) rather than threading peerId through
  // WorkerEntry.js's PEER_CONNECT -> PlayerManager.addPlayer, which would need a new field on every
  // transport type (WorkerTransport/PeerTransport/real WS) for a value only voice actually needs.
  const voiceIdentities = new Map()

  // Nostr auth challenge (cross-project-identity-nostr-login-flow): opt-in per world config.
  // When enabled, every new connection must pass a nostr auth challenge before joining.
  const _nostrAuthCfg = ctx.currentWorldDef?.identity?.nostrAuth
  const nostrAuthServer = createNostrAuthServer({
    enableChallenge: !!(_nostrAuthCfg?.enabled),
    challengeTimeoutMs: _nostrAuthCfg?.timeoutMs || 15000,
  })

  // The WORLD_DEF and APP_MODULE sends are the client bootstrap wire-contract; both the initial
  // connect and the reconnect path emit them identically (only the target id differs), so keep them
  // single-sourced here -- a drift between the two copies would desync a reconnecting client.
  function sendWorldDefAndModules(targetId) {
    if (ctx.currentWorldDef) {
      const { entities: _ignored, ...worldDefForClient } = ctx.currentWorldDef
      const modelUrls = [...new Set((ctx.currentWorldDef.entities || []).map(e => e.model).filter(Boolean))]
      if (modelUrls.length > 0) worldDefForClient._modelUrls = modelUrls
      const entityApps = {}; for (const e of (ctx.currentWorldDef.entities || [])) if (e.app) entityApps[e.id] = e.app
      if (Object.keys(entityApps).length > 0) worldDefForClient._entityApps = entityApps
      connections.send(targetId, MSG.WORLD_DEF, worldDefForClient)
    }
    const clientModules = appLoader.getClientModules()
    const _trustSet = new Set(ctx.currentWorldDef?.trustedApps || [])
    for (const [appName, code] of Object.entries(clientModules)) {
      connections.send(targetId, MSG.APP_MODULE, { app: appName, code, trusted: _trustSet.has(appName) || undefined })
    }
  }

  // Real join logic, unchanged from before the migration gate -- see onClientConnect below for the
  // pre-join peek that routes a MIGRATE-carrying transport here instead.
  function _joinNewPlayer(transport) {
    const spawnPoints = ctx.worldSpawnPoints || [ctx.worldSpawnPoint]
    // Host migration (client/HostMigration.js + WorkerEntry.js's migrationSnapshot apply): a rejoining
    // peer's last-known transform overrides the usual random spawn-point pick, so "state survives the
    // handoff without resetting to spawn" holds for players too, not just world entities. Two sources:
    // ctx.pendingRejoinState keyed by wireweave pubkey (transport._peerId, only set on a PeerTransport --
    // see WorkerTransport.js) for every OTHER migrating peer, and ctx.localRejoinState (set once by the
    // caller immediately before this function runs for the local WorkerTransport, which carries no
    // _peerId of its own) for the electing peer's own player becoming the new host.
    const rejoin = (transport.type === 'peer' && transport._peerId && ctx.pendingRejoinState?.get(transport._peerId))
      || (transport.type === 'worker' && ctx.localRejoinState) || null
    const sp = rejoin ? [...rejoin.position] : groundSnapSpawnPoint(ctx, [...spawnPoints[Math.floor(Math.random() * spawnPoints.length)]])
    const playerConfig = ctx.currentWorldDef?.player || {}
    const playerId = playerManager.addPlayer(transport, { position: sp, health: rejoin?.health ?? playerConfig.health, rotation: rejoin?.rotation })
    networkState.addPlayer(playerId, { position: sp })
    physicsIntegration.addPlayerCollider(playerId, playerConfig.capsuleRadius || 0.4)
    physicsIntegration.setPlayerPosition(playerId, sp)
    const playerState = playerManager.getPlayer(playerId).state
    lagCompensator.recordPlayerPosition(playerId, playerState.position, playerState.rotation, playerState.velocity, tickSystem.currentTick)
    const client = connections.addClient(playerId, transport)
    client.sessionToken = sessions.create(playerId, playerManager.getPlayer(playerId).state)
    // must guard `process` here: this also runs in the singleplayer in-Worker path (no Node `process` global), and a bare read throws before HANDSHAKE_ACK/WORLD_DEF/SNAPSHOT ever send
    client.isEditor = !(typeof process !== 'undefined' && process.env && process.env.EDITOR_TOKEN)
    connections.send(playerId, MSG.HANDSHAKE_ACK, { playerId, tick: tickSystem.currentTick, sessionToken: client.sessionToken, tickRate: ctx.tickRate, version: WIRE_PROTOCOL_VERSION, structHash: WIRE_STRUCT_HASH })
    sendWorldDefAndModules(playerId)
    const relevanceRadius = ctx.currentWorldDef?.relevanceRadius || 0
    const snapEntities = relevanceRadius > 0 ? appRuntime.getSnapshotForPlayer(sp, relevanceRadius) : appRuntime.getSnapshot()
    const playerSnap = networkState.getSnapshot()
    const combined = { tick: playerSnap.tick, timestamp: playerSnap.timestamp, players: playerSnap.players, entities: snapEntities.entities }
    connections.send(playerId, MSG.SNAPSHOT, { seq: ++ctx.snapshotSeq, ...SnapshotEncoder.encode(combined) })
    appRuntime.broadcastMessage({ type: 'player_join', playerId })
    connections.send(playerId, MSG.SCENE_GRAPH, { entities: appRuntime.getSceneGraph() })
    // Resend every already-known voice pubkey mapping to the new joiner, mirroring the resend-on-join
    // pattern already used for appearance/model overrides (see setPlayerAppearance/setPlayerModel below) --
    // a late joiner otherwise never learns which earlier peer owns which pubkey, since voice_identity is
    // only broadcast once, at the moment each peer's own VoiceSession first connects.
    for (const [pid, pubkey] of voiceIdentities) connections.send(playerId, MSG.APP_EVENT, { type: 'voice_identity', playerId: pid, pubkey })
    // Grass decal backfill (server-authoritative multiplayer parity, ctx._grassDecal, see
    // src/sdk/EditorHandlers.js's GRASS_DECAL_STAMP handler): a late-joining client otherwise never
    // learns about decals stamped before it connected, same gap voice_identity's resend-on-join closes
    // above. toJSON().stamps carries each stamp's ORIGINAL peak strength + appliedAt (not a pre-decayed
    // value) -- the joining client's own GrassDecal store independently re-derives the correct CURRENT
    // decayed strength from elapsed wall-clock time via the exact same effectiveStrength math already
    // shipped client-side, so a decal stamped 5 minutes before this join correctly renders already-partly-
    // regrown rather than freshly full-strength. Only sent when a store actually exists (no stamps have
    // ever landed yet in a fresh world) and has at least one stamp -- an empty send is harmless but pure
    // waste on every single join in the common no-decals-yet case.
    if (ctx._grassDecal && ctx._grassDecal.stampCount > 0) {
      connections.send(playerId, MSG.GRASS_DECAL_SYNC, { ok: true, stamps: ctx._grassDecal.toJSON().stamps })
    }
    // GPU-visible sculpt-overlay backfill (terrain-sculpt-late-join-gpu-resync): a late-joining client's
    // collider is already correct (ctx._terrainStreamer.heightDelta IS the server-authoritative store
    // every collider rebuild already reads through), but its OWN client-side SculptOverlay mirror starts
    // empty -- see MessageTypes.js's TERRAIN_SCULPT_SYNC doc for the full rationale. reuses the exact
    // toJSON() shape src/terrain/TerrainPhysics.js's heightDeltaJSON world-persistence round-trip already
    // uses (no new serialization format). `sp` (this player's own spawn position, computed above) doubles
    // as the initial window center -- the joining client's local HeightDelta mirror is repopulated with
    // EVERY historical stroke (cheap, sparse-map, see HeightDelta.js's own complexity notes) but the GPU
    // texture upload only needs a window near where this player actually is; a stroke far from spawn
    // becomes visible once the player walks within range of it live, same as any other client.
    if (ctx._terrainStreamer && ctx._terrainStreamer.heightDelta && ctx._terrainStreamer.heightDelta.strokeCount > 0) {
      connections.send(playerId, MSG.TERRAIN_SCULPT_SYNC, { ok: true, ...ctx._terrainStreamer.heightDelta.toJSON(), spawn: { x: sp[0], z: sp[2] } })
    }
    // Time-of-day join-time sync (server-clock-synced-time-of-day-network-sync): a one-time send so a
    // late joiner starts from the SERVER's current fraction instead of TimeOfDay.js's own default
    // startFraction, mirroring the grass-decal backfill immediately above. ctx.serverTimeOfDay is set by
    // setTickHandler (see server.js/WorkerEntry.js) and stays null/disabled unless this world opted in
    // via terrain.timeOfDay.serverAuthoritative -- no-op send skipped entirely otherwise.
    if (ctx.serverTimeOfDay && ctx.serverTimeOfDay.isEnabled()) {
      connections.send(playerId, MSG.TIME_OF_DAY_SYNC, ctx.serverTimeOfDay.getSyncPayload())
    }
    // Weather join-time sync (weather-server-driven-state-and-multiplayer-sync): a one-time send so a
    // late joiner starts from the SERVER's current weather state instead of blindly reading its own
    // static world-config `weather` block, mirroring the time-of-day join-time sync immediately above.
    // ctx.serverWeather is set by setTickHandler (see server.js/WorkerEntry.js) and stays null/disabled
    // unless this world opted in via terrain.weather.serverAuthoritative -- no-op send skipped entirely
    // otherwise, same discipline as serverTimeOfDay.
    if (ctx.serverWeather && ctx.serverWeather.isEnabled()) {
      connections.send(playerId, MSG.WEATHER_SYNC, ctx.serverWeather.getSyncPayload())
    }
    emitter.emit('playerJoin', { id: playerId })
    return playerId
  }

  // Live transport migration: an ALREADY-CONNECTED client opens a second candidate transport (e.g. a
  // WebTransport session while its WebSocket stays live, or a new socket on a fresher network path) and
  // sends MIGRATE as that transport's very FIRST message, carrying the still-active session token. Unlike
  // RECONNECT (which assumes the old connection is dead and destroys+respawns the player, broadcasting
  // PLAYER_LEAVE/player_join to everyone), migration re-points the EXISTING client record's transport in
  // place -- same playerId, same PlayerManager/NetworkState/physics collider/session token, zero broadcast,
  // zero snapshot-processor/prediction-engine reset client-side (see PhysicsNetworkClient.migrateTransport
  // and MessageHandler._handleMigrateAck). The old transport is left untouched here -- the client closes it
  // itself once MIGRATE_ACK confirms the new one is authoritative, so a MIGRATE_ACK lost in flight can't
  // strand the player with zero live transports.
  function _handleMigrate(transport, msg) {
    const token = msg.payload?.sessionToken
    if (typeof token !== 'string' || token.length < 8) { try { transport.close() } catch (e) {} return }
    const session = sessions.get(token)
    if (!session) { try { transport.send(pack({ type: MSG.MIGRATE_ACK, payload: { ok: false } })) } catch (e) {}; try { transport.close() } catch (e) {} return }
    const playerId = session.playerId
    const client = connections.getClient(playerId)
    // The session's player must actually be alive AND currently owned by a DIFFERENT (still-open) transport
    // -- a session with no live client (already disconnected) is exactly the RECONNECT case, not migration;
    // reject here so the client's migrateTransport() caller falls back to full reconnect instead of hanging.
    if (!client || !playerManager.getPlayer(playerId)) {
      try { transport.send(pack({ type: MSG.MIGRATE_ACK, payload: { ok: false } })) } catch (e) {}
      try { transport.close() } catch (e) {}
      return
    }
    const oldTransport = client.transport
    // Re-point the live client record's transport + re-wire this NEW transport's message/close/error
    // listeners onto the SAME clientId (playerId) -- detachClient strips the OLD transport's listeners
    // first so its later close (the client closing it post-ack) can't fire a stray 'disconnect' for a
    // connection that is being intentionally retired, not lost.
    connections.detachClient(playerId)
    const migratedClient = connections.addClient(playerId, transport)
    migratedClient.sessionToken = token
    migratedClient.isEditor = client.isEditor
    connections.send(playerId, MSG.MIGRATE_ACK, { ok: true, playerId, tick: tickSystem.currentTick, structHash: WIRE_STRUCT_HASH })
    // The old transport is deliberately NOT closed here -- its message/close/error listeners are already
    // detached above so it can no longer route traffic into this player or fire a stray disconnect, but
    // the underlying socket stays physically open until the CLIENT closes it (after it confirms the new
    // transport is authoritative). That ordering means a MIGRATE_ACK lost in flight leaves the client with
    // a still-open fallback socket to detect the failure against, instead of a hard server-side cut
    // mid-swap that could strand the player with zero live transports.
    void oldTransport
    emitter.emit('playerMigrate', { id: playerId })
  }

  // Gate every newly-opened transport on its FIRST message before running the normal (heavier, join-
  // broadcasting) onClientConnect flow: a MIGRATE-carrying first message routes to _handleMigrate instead
  // of spawning a brand-new player (which would have allocated a duplicate PlayerManager entry + physics
  // collider and broadcast a spurious player_join for what is really the SAME player). Every other first
  // message (including the empty/no-message case -- a plain join never sends anything before the server's
  // own HANDSHAKE_ACK) falls through to the ordinary join path unchanged, replaying that first message
  // through the real per-connection dispatcher afterward so nothing is silently dropped.
  function onClientConnect(transport) {
    let joined = false
    let authPending = false

    // When nostr auth is enabled, send a challenge immediately. The client's first message
    // must be a valid NOSTR_AUTH_RESPONSE before the normal join flow proceeds.
    if (nostrAuthServer.isEnabled()) {
      authPending = true
      nostrAuthServer.challengeConnection(transport).then(challenge => {
        if (challenge) transport.send(pack({ type: MSG.NOSTR_AUTH_CHALLENGE, payload: { challenge } }))
      }).catch(() => { try { transport.close() } catch {} })
    }

    const peek = (data) => {
      transport.off('message', peek)
      let msg
      try { msg = unpack(data) } catch (e) { _replayFirstMessage(_joinNewPlayer(transport), data); return }

      // Nostr auth response takes priority over MIGRATE -- if auth is pending, only
      // NOSTR_AUTH_RESPONSE is accepted as the first message.
      if (authPending && msg?.type === MSG.NOSTR_AUTH_RESPONSE) {
        authPending = false
        joined = true
        nostrAuthServer.verifyResponse(transport, msg.payload).then(result => {
          if (result.ok) {
            transport._nostrPubkey = result.pubkey || null
            _joinNewPlayer(transport)
          } else {
            try { transport.send(pack({ type: MSG.NOSTR_AUTH_CHALLENGE, payload: { error: result.error } })) } catch {}
            try { transport.close() } catch {}
          }
        }).catch(() => { try { transport.close() } catch {} })
        return
      }

      // If auth is pending but the first message is NOT a valid auth response, reject.
      if (authPending) {
        joined = true
        try { transport.send(pack({ type: MSG.NOSTR_AUTH_CHALLENGE, payload: { error: 'auth required' } })) } catch {}
        try { transport.close() } catch {}
        return
      }

      joined = true
      if (msg?.type === MSG.MIGRATE) { _handleMigrate(transport, msg); return }
      _replayFirstMessage(_joinNewPlayer(transport), data)
    }
    transport.on('message', peek)

    const _MIGRATE_PEEK_GRACE_FLOOR_MS = 50
    const _MIGRATE_PEEK_GRACE_CEIL_MS = 1500
    const _dilation = tickSystem?.dilationFactor
    const _migratePeekGraceMs = (typeof _dilation === 'number' && _dilation > 0 && _dilation < 1)
      ? Math.min(_MIGRATE_PEEK_GRACE_CEIL_MS, Math.round(_MIGRATE_PEEK_GRACE_FLOOR_MS / _dilation))
      : _MIGRATE_PEEK_GRACE_FLOOR_MS
    setTimeout(() => {
      if (!joined && !authPending) {
        transport.off('message', peek)
        _joinNewPlayer(transport)
      }
    }, _migratePeekGraceMs)
  }

  // Re-delivers a transport's first message (already consumed by the migration-peek listener above)
  // through the SAME per-clientId dispatcher every subsequent message goes through, once the transport is
  // registered via connections.addClient inside _joinNewPlayer -- otherwise a client that legitimately
  // sends real traffic before HANDSHAKE_ACK (none do today, but nothing in the wire contract forbids it)
  // would have that first message silently eaten by the peek listener. playerId is _joinNewPlayer's own
  // return value (O(1), no transport-identity scan needed).
  function _replayFirstMessage(playerId, data) {
    let msg
    try { msg = unpack(data) } catch (e) { return }
    connections.emit('message', playerId, msg)
  }

  // Wrapped in try/catch: `connections.on('message', ...)` is an ASYNC listener invoked via
  // EventEmitter.emit's synchronous `fn(...args)` call (src/protocol/EventEmitter.js) -- emit's own
  // try/catch can never see a throw from an async function body, because calling an async function
  // never throws synchronously; it always returns a (possibly rejected) Promise that nothing here
  // awaits or .catches. Before this wrapper, a bug anywhere in this dispatcher (or a handler it calls,
  // e.g. editorHandlers.handle) silently vanished as an unhandled promise rejection -- no console output,
  // no visible symptom beyond "the client never got a reply". Found via LIST_FS_TREE never round-tripping
  // with zero error surfaced anywhere (browser console, page errors, worker console, server stdout).
  connections.on('message', (clientId, msg) => {
    _onClientMessage(clientId, msg).catch(err => console.error(`[connection] message handler failed (type ${msg?.type}) for client ${clientId}:`, err?.stack || err?.message || err))
  })
  async function _onClientMessage(clientId, msg) {
    if (inspector.handleMessage(clientId, msg)) return
    if (msg.type === MSG.HEARTBEAT) {
      const ts = msg.payload?.timestamp
      if (typeof ts === 'number' && Number.isFinite(ts)) {
        const now = Date.now()
        const rtt = now - ts
        const client = connections.getClient(clientId)
        if (client) {
          client.rtt = client.rtt != null ? Math.round(client.rtt * 0.7 + rtt * 0.3) : rtt
          if (client.rtt < 0) client.rtt = 0
          if (client.rtt > 10000) client.rtt = 10000   // cap: a spoofed/far-skewed timestamp must not feed an absurd RTT into latency logic
        }
        connections.send(clientId, MSG.HEARTBEAT_ACK, { timestamp: ts, serverTime: now })
      } else {
        connections.send(clientId, MSG.HEARTBEAT_ACK, {})
      }
      return
    }
    if (msg.type === MSG.INPUT || msg.type === MSG.PLAYER_INPUT) {
      // Anti-cheat baseline (anticheat-server-envelope-checks, see docs/anticheat.md "Tractable
      // dedicated-server mitigations"): (1) a per-connection token bucket drops input messages beyond
      // the legitimate ~60/sec input-loop rate -- silently, matching ServerAPI.js's debugLogRateLimited
      // discipline (drop, don't disconnect, so a real client caught in one scheduler hiccup is never
      // punished). (2) every numeric field (yaw/pitch/analogForward/analogRight) on both the primary
      // input AND every redundant-resend entry is sanitized in place BEFORE reaching addInput --
      // TickHandler.js's processPlayerMovement computes st.rotation directly from inp.yaw via
      // Math.sin/cos(yaw/2) outside applyMovement's own accidentally-NaN-safe accel math, so an
      // unsanitized `yaw: Infinity` live-poisons the authoritative in-memory player state (see
      // InputGuard.js's header comment for the full live-witnessed mechanism).
      if (isInputRateLimited(clientId)) return
      const pl = msg.payload || {}
      // redundant inputs applied first, in order, then newest; addInput dedupes by sequence so a gap-filling resend never double-applies
      if (Array.isArray(pl.redundant)) for (const r of pl.redundant) if (r && typeof r === 'object' && Number.isFinite(r.sequence)) playerManager.addInput(clientId, sanitizeInputPayload(r.data), r.sequence)
      playerManager.addInput(clientId, sanitizeInputPayload(pl.input || pl), pl.sequence)
      return
    }
    if (msg.type === MSG.APP_EVENT) {
      // Voice-identity self-registration: a client announces its own wireweave nostr pubkey once its
      // VoiceSession connects, so every OTHER client can resolve that pubkey to this player's real
      // world position (pm.playerMeshes.get(playerId)) for proximity-attenuated voice. clientId here is
      // the server-authoritative connection id (never trust a client-asserted playerId), same trust
      // model as the pick handler just below.
      if (msg.payload?.type === 'voice_identity' && typeof msg.payload?.pubkey === 'string' && msg.payload.pubkey) {
        const pubkey = msg.payload.pubkey.slice(0, 128)
        if (voiceIdentities.get(clientId) !== pubkey) {
          voiceIdentities.set(clientId, pubkey)
          connections.broadcast(MSG.APP_EVENT, { type: 'voice_identity', playerId: clientId, pubkey })
        }
        return
      }
      if (msg.payload?.entityId) appRuntime.fireInteract(msg.payload.entityId, { id: clientId })
      // Server-authoritative click/pick: a client raycast that hit an app entity sends {type:'pick',entityId,point}.
      // Route it straight to THAT entity's app as onPick(ctx,{playerId,point,entityId}) so the server -- not just the
      // client -- knows what was clicked (click-target games: shooters, whack-a-mole, board pieces, buttons). The
      // client point is advisory (untrusted); the app decides what the pick means. Still also broadcast as a message
      // below so global listeners see it.
      if (msg.payload?.type === 'pick' && msg.payload?.entityId != null) {
        appRuntime.fireEvent(msg.payload.entityId, 'onPick', { playerId: clientId, point: msg.payload.point ?? null, entityId: msg.payload.entityId })
      }
      const eventData = { ...msg.payload, senderId: clientId }
      appRuntime.broadcastMessage(eventData)
      return
    }
    if (msg.type === MSG.RECONNECT) {
      const _token = msg.payload?.sessionToken
      if (typeof _token !== 'string' || _token.length < 8) {
        connections.send(clientId, MSG.DISCONNECT_REASON, { code: DISCONNECT_REASONS.INVALID_SESSION })
        return
      }
      const session = sessions.get(_token)
      if (!session) {
        connections.send(clientId, MSG.DISCONNECT_REASON, { code: DISCONNECT_REASONS.INVALID_SESSION })
        return
      }
      const oldId = session.playerId
      const savedState = session.state || {}
      const client = connections.getClient(clientId)
      const transport = client?.transport
      if (!transport) return
      const playerConfig = ctx.currentWorldDef?.player || {}
      // falls back to world spawn on anything that isn't a finite 3-vector, so corrupt session state can't NaN-poison the snapshot
      let sp = savedState.position
      if (!Array.isArray(sp) || sp.length !== 3 || sp.some(x => !Number.isFinite(x))) sp = groundSnapSpawnPoint(ctx, [...ctx.worldSpawnPoint])
      if (playerManager.getPlayer(oldId)) {
        playerManager.removePlayer(oldId)
        networkState.removePlayer(oldId)
        physicsIntegration.removePlayerCollider(oldId)
        lagCompensator.clearPlayerHistory(oldId)
        clearInputBucket(oldId)
        clearOutlierWindow(oldId)
        transformRingWriter?.release(oldId)
        connections.broadcast(MSG.PLAYER_LEAVE, { playerId: oldId })
      }
      if (clientId !== oldId && playerManager.getPlayer(clientId)) {
        playerManager.removePlayer(clientId)
        networkState.removePlayer(clientId)
        physicsIntegration.removePlayerCollider(clientId)
        lagCompensator.clearPlayerHistory(clientId)
        clearInputBucket(clientId)
        clearOutlierWindow(clientId)
        transformRingWriter?.release(clientId)
        connections.broadcast(MSG.PLAYER_LEAVE, { playerId: clientId })
      }
      connections.detachClient(clientId)
      // savedState comes from an untrusted session token; validate each field or a tampered reconnect poisons every client's next snapshot
      const _vec = (v, n) => (Array.isArray(v) && v.length === n && v.every(Number.isFinite)) ? v : undefined
      // clamp to [0,maxHealth] so a tampered token (health=1e308) can't reconnect an unkillable player
      const _maxHealth = playerConfig.health ?? 100
      const health = (Number.isFinite(savedState.health) && savedState.health >= 0)
        ? Math.min(savedState.health, _maxHealth) : _maxHealth
      const newId = playerManager.addPlayer(transport, { position: sp, health, velocity: _vec(savedState.velocity, 3), rotation: _vec(savedState.rotation, 4) })
      networkState.addPlayer(newId, { position: sp })
      physicsIntegration.addPlayerCollider(newId, playerConfig.capsuleRadius || 0.4)
      physicsIntegration.setPlayerPosition(newId, sp)
      const reconnClient = connections.addClient(newId, transport)
      reconnClient.sessionToken = msg.payload.sessionToken
      // addClient() builds a fresh client record with no isEditor field -- unlike the MIGRATE path
      // (which explicitly copies migratedClient.isEditor = client.isEditor a few lines above in this
      // same file), RECONNECT never carried it forward, so any reconnecting client (a heartbeat-timeout
      // blip, not just an explicit reload) silently lost editor authorization for the rest of its
      // session -- live-witnessed this session via a real WS reconnect: PLACE_APP/LIST_APPS both
      // rejected with "[editor-auth] rejected ... from unauthorized client" post-reconnect even with
      // EDITOR_TOKEN unset (the dev-open default). Recompute the same way _joinNewPlayer does, matching
      // MIGRATE's own "carry the flag across a transport swap" discipline.
      reconnClient.isEditor = !(typeof process !== 'undefined' && process.env && process.env.EDITOR_TOKEN)
      sessions.update(msg.payload.sessionToken, { state: playerManager.getPlayer(newId).state })
      // carries authoritative position/health so PredictionEngine re-inits at the real spot, not [0,0,0]
      connections.send(newId, MSG.RECONNECT_ACK, { playerId: newId, tick: tickSystem.currentTick, sessionToken: msg.payload.sessionToken, tickRate: ctx.tickRate, position: sp, health, structHash: WIRE_STRUCT_HASH })
      sendWorldDefAndModules(newId)
      const snap = networkState.getSnapshot()
      const ents = appRuntime.getSnapshot()
      connections.send(newId, MSG.STATE_RECOVERY, { snapshot: SnapshotEncoder.encode({ tick: snap.tick, timestamp: snap.timestamp, players: snap.players, entities: ents.entities }), tick: tickSystem.currentTick })
      // reconnected:true so the app doesn't force-reset health/score on a network blip
      appRuntime.broadcastMessage({ type: 'player_join', playerId: newId, reconnected: true })
      emitter.emit('playerJoin', { id: newId, reconnected: true })
      return
    }
    if (msg.type === MSG.TRIMESH_DATA) {
      const { entityId, vertices, indices } = msg.payload || {}
      if (!vertices || !indices) return
      // rate guard: caps retries to once/500ms per entity so a flood of near-max-size payloads can't force a Jolt build on every message; checked before the validation loop
      const _TRIMESH_RETRY_COOLDOWN_MS = 500
      if (!appRuntime._trimeshLastAttempt) appRuntime._trimeshLastAttempt = new Map()
      const _now = Date.now(), _last = appRuntime._trimeshLastAttempt.get(entityId) || 0
      if (_now - _last < _TRIMESH_RETRY_COOLDOWN_MS) return
      appRuntime._trimeshLastAttempt.set(entityId, _now)
      // client-supplied vertices/indices flow straight into Jolt mesh construction by index; unvalidated, a malformed packet causes an OOB read + NaN-poisoned shape broadcast to every client
      const MAX_VERTS = 300000, MAX_TRIS = 200000
      if (!Array.isArray(vertices) || !Array.isArray(indices)) return
      if (vertices.length === 0 || vertices.length % 3 !== 0 || vertices.length / 3 > MAX_VERTS) return
      if (indices.length === 0 || indices.length % 3 !== 0 || indices.length / 3 > MAX_TRIS) return
      const vertCount = vertices.length / 3
      for (let i = 0; i < vertices.length; i++) if (!Number.isFinite(vertices[i])) return
      for (let i = 0; i < indices.length; i++) { const ix = indices[i]; if (!Number.isInteger(ix) || ix < 0 || ix >= vertCount) return }
      const ent = appRuntime._pendingTrimeshEntities?.get(entityId)
      if (!ent) {
        const existing = appRuntime.entities.get(entityId)
        if (existing?._physicsBodyId) return
        console.warn('[trimesh] entity not in pending list:', entityId); return
      }
      if (ent._physicsBodyId) { console.warn('[trimesh] entity already has body:', entityId); return }
      try {
        const bid = appRuntime._physics.addStaticTrimeshFromData(entityId, vertices, indices, [0,0,0], [0,0,0,1])
        if (bid != null) { ent._physicsBodyId = bid; appRuntime._physicsBodyToEntityId?.set(bid, entityId); appRuntime._pendingTrimeshEntities.delete(entityId); appRuntime._trimeshLastAttempt.delete(entityId) }
        else console.error('[trimesh] null body for', entityId)
      } catch(e) { console.error('[trimesh] failed for', entityId, e.message) }
      return
    }
    if (msg.type === MSG.AUTH_EDITOR) {
      const client = connections.getClient(clientId)
      // same cross-environment guard as onClientConnect: runs in the singleplayer in-Worker path too, no Node `process` global there
      const _tok = typeof process !== 'undefined' && process.env ? process.env.EDITOR_TOKEN : undefined
      const ok = !!_tok && timingSafeTokenEqual(msg.payload?.token, _tok)
      if (client && ok) client.isEditor = true
      connections.send(clientId, MSG.AUTH_EDITOR_ACK, { ok })
      return
    }
    if (editorHandlers.HANDLED_TYPES.has(msg.type)) {
      const client = connections.getClient(clientId)
      if (!client?.isEditor) { console.warn(`[editor-auth] rejected ${msg.type} from unauthorized client ${clientId}`); return }
    }
    if (editorHandlers.handle(msg.type, msg.payload, clientId)) return
    emitter.emit('message', clientId, msg)
  }

  connections.on('disconnect', (clientId, reason) => {
    const client = connections.getClient(clientId)
    if (client?.sessionToken) { const p = playerManager.getPlayer(clientId); if (p) sessions.update(client.sessionToken, { state: p.state }) }
    appRuntime.broadcastMessage({ type: 'player_leave', playerId: clientId })
    physicsIntegration.removePlayerCollider(clientId)
    lagCompensator.clearPlayerHistory(clientId)
    inspector.removeClient(clientId)
    playerManager.removePlayer(clientId)
    networkState.removePlayer(clientId)
    voiceIdentities.delete(clientId)
    clearInputBucket(clientId)
    clearOutlierWindow(clientId)
    transformRingWriter?.release(clientId)
    connections.broadcast(MSG.PLAYER_LEAVE, { playerId: clientId })
    emitter.emit('playerLeave', { id: clientId, reason })
  })

  return { onClientConnect }
}
