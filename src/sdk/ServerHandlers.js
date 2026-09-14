import { MSG, DISCONNECT_REASONS, WIRE_PROTOCOL_VERSION } from '../protocol/MessageTypes.js'
import { WIRE_STRUCT_HASH, unpack, pack } from '../protocol/msgpack.js'
import { SnapshotEncoder } from '../netcode/SnapshotEncoder.js'
import { createEditorHandlers } from './EditorHandlers.js'
import { timingSafeTokenEqual } from './authCompare.js'
import { isInputRateLimited, clearInputBucket, sanitizeInputPayload } from '../netcode/InputGuard.js'
import { clearOutlierWindow } from '../netcode/OutlierDetector.js'
import { createNostrAuthServer } from './NostrAuthServer.js'

const SPAWN_SNAP_RAY_START_ABOVE = 20
const SPAWN_SNAP_RAY_LENGTH = 40
const SPAWN_SNAP_GROUND_CLEARANCE = 2
const MAX_TRACKED_RTT_MS = 10000

function groundSnapSpawnPoint(ctx, sp) {
  if (!ctx.physics || typeof ctx.physics.raycast !== 'function') return sp
  const hit = ctx.physics.raycast([sp[0], sp[1] + SPAWN_SNAP_RAY_START_ABOVE, sp[2]], [0, -1, 0], SPAWN_SNAP_RAY_LENGTH)
  if (hit && hit.hit && Number.isFinite(hit.position?.[1])) return [sp[0], hit.position[1] + SPAWN_SNAP_GROUND_CLEARANCE, sp[2]]
  return sp
}

function readEditorTokenIfNodeRuntime() {
  return typeof process !== 'undefined' && process.env ? process.env.EDITOR_TOKEN : undefined
}

export function createConnectionHandlers(ctx) {
  const { tickSystem, playerManager, networkState, lagCompensator, physicsIntegration, connections, sessions, appLoader, appRuntime, emitter, inspector } = ctx
  const transformRingWriter = ctx.transformRingWriter || null
  const editorHandlers = createEditorHandlers(ctx)
  const voiceIdentities = new Map()

  const _nostrAuthCfg = ctx.currentWorldDef?.identity?.nostrAuth
  const nostrAuthServer = createNostrAuthServer({
    enableChallenge: !!(_nostrAuthCfg?.enabled),
    challengeTimeoutMs: _nostrAuthCfg?.timeoutMs || 15000,
  })

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

  function _joinNewPlayer(transport) {
    const spawnPoints = ctx.worldSpawnPoints || [ctx.worldSpawnPoint]
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
    client.isEditor = !readEditorTokenIfNodeRuntime()
    connections.send(playerId, MSG.HANDSHAKE_ACK, { playerId, tick: tickSystem.currentTick, sessionToken: client.sessionToken, tickRate: ctx.tickRate, version: WIRE_PROTOCOL_VERSION, structHash: WIRE_STRUCT_HASH })
    sendWorldDefAndModules(playerId)
    const relevanceRadius = ctx.currentWorldDef?.relevanceRadius || 0
    const snapEntities = relevanceRadius > 0 ? appRuntime.getSnapshotForPlayer(sp, relevanceRadius) : appRuntime.getSnapshot()
    const playerSnap = networkState.getSnapshot()
    const combined = { tick: playerSnap.tick, timestamp: playerSnap.timestamp, players: playerSnap.players, entities: snapEntities.entities }
    connections.send(playerId, MSG.SNAPSHOT, { seq: ++ctx.snapshotSeq, ...SnapshotEncoder.encode(combined) })
    appRuntime.broadcastMessage({ type: 'player_join', playerId })
    connections.send(playerId, MSG.SCENE_GRAPH, { entities: appRuntime.getSceneGraph() })
    for (const [pid, pubkey] of voiceIdentities) connections.send(playerId, MSG.APP_EVENT, { type: 'voice_identity', playerId: pid, pubkey })
    if (ctx._grassDecal && ctx._grassDecal.stampCount > 0) {
      connections.send(playerId, MSG.GRASS_DECAL_SYNC, { ok: true, stamps: ctx._grassDecal.toJSON().stamps })
    }
    if (ctx._terrainStreamer && ctx._terrainStreamer.heightDelta && ctx._terrainStreamer.heightDelta.strokeCount > 0) {
      connections.send(playerId, MSG.TERRAIN_SCULPT_SYNC, { ok: true, ...ctx._terrainStreamer.heightDelta.toJSON(), spawn: { x: sp[0], z: sp[2] } })
    }
    if (ctx.serverTimeOfDay && ctx.serverTimeOfDay.isEnabled()) {
      connections.send(playerId, MSG.TIME_OF_DAY_SYNC, ctx.serverTimeOfDay.getSyncPayload())
    }
    if (ctx.serverWeather && ctx.serverWeather.isEnabled()) {
      connections.send(playerId, MSG.WEATHER_SYNC, ctx.serverWeather.getSyncPayload())
    }
    emitter.emit('playerJoin', { id: playerId })
    return playerId
  }

  function _handleMigrate(transport, msg) {
    const token = msg.payload?.sessionToken
    if (typeof token !== 'string' || token.length < 8) { try { transport.close() } catch (e) {} return }
    const session = sessions.get(token)
    if (!session) { try { transport.send(pack({ type: MSG.MIGRATE_ACK, payload: { ok: false } })) } catch (e) {}; try { transport.close() } catch (e) {} return }
    const playerId = session.playerId
    const client = connections.getClient(playerId)
    if (!client || !playerManager.getPlayer(playerId)) {
      try { transport.send(pack({ type: MSG.MIGRATE_ACK, payload: { ok: false } })) } catch (e) {}
      try { transport.close() } catch (e) {}
      return
    }
    const oldTransportLeftOpenForClientToClose = client.transport
    connections.detachClient(playerId)
    const migratedClient = connections.addClient(playerId, transport)
    migratedClient.sessionToken = token
    migratedClient.isEditor = client.isEditor
    connections.send(playerId, MSG.MIGRATE_ACK, { ok: true, playerId, tick: tickSystem.currentTick, structHash: WIRE_STRUCT_HASH })
    void oldTransportLeftOpenForClientToClose
    emitter.emit('playerMigrate', { id: playerId })
  }

  function onClientConnect(transport) {
    let joined = false
    let authPending = false

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

  function _replayFirstMessage(playerId, data) {
    let msg
    try { msg = unpack(data) } catch (e) { return }
    connections.emit('message', playerId, msg)
  }

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
          if (client.rtt > MAX_TRACKED_RTT_MS) client.rtt = MAX_TRACKED_RTT_MS
        }
        connections.send(clientId, MSG.HEARTBEAT_ACK, { timestamp: ts, serverTime: now })
      } else {
        connections.send(clientId, MSG.HEARTBEAT_ACK, {})
      }
      return
    }
    if (msg.type === MSG.INPUT || msg.type === MSG.PLAYER_INPUT) {
      if (isInputRateLimited(clientId)) return
      const pl = msg.payload || {}
      if (Array.isArray(pl.redundant)) for (const r of pl.redundant) if (r && typeof r === 'object' && Number.isFinite(r.sequence)) playerManager.addInput(clientId, sanitizeInputPayload(r.data), r.sequence)
      playerManager.addInput(clientId, sanitizeInputPayload(pl.input || pl), pl.sequence)
      return
    }
    if (msg.type === MSG.APP_EVENT) {
      if (msg.payload?.type === 'voice_identity' && typeof msg.payload?.pubkey === 'string' && msg.payload.pubkey) {
        const pubkey = msg.payload.pubkey.slice(0, 128)
        if (voiceIdentities.get(clientId) !== pubkey) {
          voiceIdentities.set(clientId, pubkey)
          connections.broadcast(MSG.APP_EVENT, { type: 'voice_identity', playerId: clientId, pubkey })
        }
        return
      }
      if (msg.payload?.entityId) appRuntime.fireInteract(msg.payload.entityId, { id: clientId })
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
      const _vec = (v, n) => (Array.isArray(v) && v.length === n && v.every(Number.isFinite)) ? v : undefined
      const _maxHealth = playerConfig.health ?? 100
      const health = (Number.isFinite(savedState.health) && savedState.health >= 0)
        ? Math.min(savedState.health, _maxHealth) : _maxHealth
      const newId = playerManager.addPlayer(transport, { position: sp, health, velocity: _vec(savedState.velocity, 3), rotation: _vec(savedState.rotation, 4) })
      networkState.addPlayer(newId, { position: sp })
      physicsIntegration.addPlayerCollider(newId, playerConfig.capsuleRadius || 0.4)
      physicsIntegration.setPlayerPosition(newId, sp)
      const reconnClient = connections.addClient(newId, transport)
      reconnClient.sessionToken = msg.payload.sessionToken
      reconnClient.isEditor = !readEditorTokenIfNodeRuntime()
      sessions.update(msg.payload.sessionToken, { state: playerManager.getPlayer(newId).state })
      connections.send(newId, MSG.RECONNECT_ACK, { playerId: newId, tick: tickSystem.currentTick, sessionToken: msg.payload.sessionToken, tickRate: ctx.tickRate, position: sp, health, structHash: WIRE_STRUCT_HASH })
      sendWorldDefAndModules(newId)
      const snap = networkState.getSnapshot()
      const ents = appRuntime.getSnapshot()
      connections.send(newId, MSG.STATE_RECOVERY, { snapshot: SnapshotEncoder.encode({ tick: snap.tick, timestamp: snap.timestamp, players: snap.players, entities: ents.entities }), tick: tickSystem.currentTick })
      appRuntime.broadcastMessage({ type: 'player_join', playerId: newId, reconnected: true })
      emitter.emit('playerJoin', { id: newId, reconnected: true })
      return
    }
    if (msg.type === MSG.TRIMESH_DATA) {
      const { entityId, vertices, indices } = msg.payload || {}
      if (!vertices || !indices) return
      const _TRIMESH_RETRY_COOLDOWN_MS = 500
      if (!appRuntime._trimeshLastAttempt) appRuntime._trimeshLastAttempt = new Map()
      const _now = Date.now(), _last = appRuntime._trimeshLastAttempt.get(entityId) || 0
      if (_now - _last < _TRIMESH_RETRY_COOLDOWN_MS) return
      appRuntime._trimeshLastAttempt.set(entityId, _now)
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
      const _tok = readEditorTokenIfNodeRuntime()
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
