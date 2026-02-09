import { MSG, DISCONNECT_REASONS } from '../protocol/MessageTypes.js'
import { SnapshotEncoder } from '../netcode/SnapshotEncoder.js'

export function createConnectionHandlers(ctx) {
  const { tickSystem, playerManager, networkState, lagCompensator, physicsIntegration, connections, sessions, appLoader, appRuntime, emitter, inspector } = ctx

  function onClientConnect(transport) {
    const sp = [...ctx.worldSpawnPoint]
    const playerConfig = ctx.currentWorldDef?.player || {}
    const playerId = playerManager.addPlayer(transport, { position: sp, health: playerConfig.health })
    networkState.addPlayer(playerId, { position: sp })
    physicsIntegration.addPlayerCollider(playerId, playerConfig.capsuleRadius || 0.4)
    physicsIntegration.setPlayerPosition(playerId, sp)
    const playerState = playerManager.getPlayer(playerId).state
    lagCompensator.recordPlayerPosition(playerId, playerState.position, playerState.rotation, playerState.velocity, tickSystem.currentTick)
    const client = connections.addClient(playerId, transport)
    client.sessionToken = sessions.create(playerId, playerManager.getPlayer(playerId).state)
    connections.send(playerId, MSG.HANDSHAKE_ACK, { playerId, tick: tickSystem.currentTick, sessionToken: client.sessionToken, tickRate: ctx.tickRate })
    if (ctx.currentWorldDef) {
      connections.send(playerId, MSG.WORLD_DEF, ctx.currentWorldDef)
    }
    const clientModules = appLoader.getClientModules()
    for (const [appName, code] of Object.entries(clientModules)) {
      connections.send(playerId, MSG.APP_MODULE, { app: appName, code })
    }
    const snap = appRuntime.getSnapshot()
    connections.send(playerId, MSG.SNAPSHOT, { seq: ++ctx.snapshotSeq, ...SnapshotEncoder.encode(snap) })
    for (const [entityId] of appRuntime.apps) appRuntime.fireMessage(entityId, { type: 'player_join', playerId })
    emitter.emit('playerJoin', { id: playerId })
  }

  connections.on('message', (clientId, msg) => {
    if (inspector.handleMessage(clientId, msg)) return
    if (msg.type === MSG.INPUT || msg.type === MSG.PLAYER_INPUT) {
      playerManager.addInput(clientId, msg.payload?.input || msg.payload)
      return
    }
    if (msg.type === MSG.APP_EVENT) {
      if (msg.payload?.entityId) appRuntime.fireInteract(msg.payload.entityId, { id: clientId })
      const eventData = { ...msg.payload, senderId: clientId }
      for (const [entityId] of appRuntime.apps) {
        appRuntime.fireMessage(entityId, eventData)
      }
      return
    }
    if (msg.type === MSG.RECONNECT) {
      const session = sessions.get(msg.payload?.sessionToken)
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
      const sp = savedState.position || [...ctx.worldSpawnPoint]
      playerManager.removePlayer(clientId)
      networkState.removePlayer(clientId)
      physicsIntegration.removePlayerCollider(clientId)
      lagCompensator.clearPlayerHistory(clientId)
      connections.removeClient(clientId)
      const newId = playerManager.addPlayer(transport, { position: sp, health: savedState.health ?? playerConfig.health ?? 100, velocity: savedState.velocity, rotation: savedState.rotation })
      networkState.addPlayer(newId, { position: sp })
      physicsIntegration.addPlayerCollider(newId, playerConfig.capsuleRadius || 0.4)
      physicsIntegration.setPlayerPosition(newId, sp)
      const reconnClient = connections.addClient(newId, transport)
      reconnClient.sessionToken = msg.payload.sessionToken
      sessions.update(msg.payload.sessionToken, { state: playerManager.getPlayer(newId).state })
      connections.send(newId, MSG.RECONNECT_ACK, { playerId: newId, tick: tickSystem.currentTick, sessionToken: msg.payload.sessionToken })
      if (ctx.currentWorldDef) connections.send(newId, MSG.WORLD_DEF, ctx.currentWorldDef)
      const clientModules = appLoader.getClientModules()
      for (const [appName, code] of Object.entries(clientModules)) {
        connections.send(newId, MSG.APP_MODULE, { app: appName, code })
      }
      const snap = networkState.getSnapshot()
      const ents = appRuntime.getSnapshot()
      connections.send(newId, MSG.STATE_RECOVERY, { snapshot: SnapshotEncoder.encode({ tick: snap.tick, timestamp: snap.timestamp, players: snap.players, entities: ents.entities }), tick: tickSystem.currentTick })
      for (const [entityId] of appRuntime.apps) appRuntime.fireMessage(entityId, { type: 'player_join', playerId: newId })
      emitter.emit('playerJoin', { id: newId, reconnected: true })
      return
    }
    emitter.emit('message', clientId, msg)
  })

  connections.on('disconnect', (clientId, reason) => {
    const client = connections.getClient(clientId)
    if (client?.sessionToken) { const p = playerManager.getPlayer(clientId); if (p) sessions.update(client.sessionToken, { state: p.state }) }
    for (const [entityId] of appRuntime.apps) appRuntime.fireMessage(entityId, { type: 'player_leave', playerId: clientId })
    physicsIntegration.removePlayerCollider(clientId)
    lagCompensator.clearPlayerHistory(clientId)
    inspector.removeClient(clientId)
    playerManager.removePlayer(clientId)
    networkState.removePlayer(clientId)
    connections.broadcast(MSG.PLAYER_LEAVE, { playerId: clientId })
    emitter.emit('playerLeave', { id: clientId, reason })
  })

  return { onClientConnect }
}
