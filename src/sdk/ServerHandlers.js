import { MSG, DISCONNECT_REASONS } from '../protocol/MessageTypes.js'
import { SnapshotEncoder } from '../netcode/SnapshotEncoder.js'

export function createConnectionHandlers(ctx) {
  const { tickSystem, playerManager, networkState, lagCompensator, physicsIntegration, connections, sessions, appLoader, appRuntime, emitter, inspector } = ctx

  function onClientConnect(transport) {
    const sp = [...ctx.worldSpawnPoint]
    const playerId = playerManager.addPlayer(transport, { position: sp })
    networkState.addPlayer(playerId, { position: sp })
    physicsIntegration.addPlayerCollider(playerId, 0.4)
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
    appRuntime.fireMessage('game', { type: 'player_join', playerId })
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
      if (msg.payload?.type === 'fire') {
        const shooter = playerManager.getPlayer(clientId)
        const pos = shooter?.state?.position || [0, 0, 0]
        const origin = [pos[0], pos[1] + 0.9, pos[2]]
        appRuntime.fireMessage('game', { ...msg.payload, shooterId: clientId, origin })
      }
      return
    }
    if (msg.type === MSG.RECONNECT) {
      const session = sessions.get(msg.payload?.sessionToken)
      if (!session) {
        connections.send(clientId, MSG.DISCONNECT_REASON, { code: DISCONNECT_REASONS.INVALID_SESSION })
        return
      }
      const snap = networkState.getSnapshot()
      const ents = appRuntime.getSnapshot()
      connections.send(clientId, MSG.RECONNECT_ACK, { playerId: session.playerId, tick: tickSystem.currentTick, sessionToken: msg.payload.sessionToken })
      connections.send(clientId, MSG.STATE_RECOVERY, { snapshot: SnapshotEncoder.encode({ tick: snap.tick, timestamp: snap.timestamp, players: snap.players, entities: ents.entities }), tick: tickSystem.currentTick })
      return
    }
    emitter.emit('message', clientId, msg)
  })

  connections.on('disconnect', (clientId, reason) => {
    const client = connections.getClient(clientId)
    if (client?.sessionToken) { const p = playerManager.getPlayer(clientId); if (p) sessions.update(client.sessionToken, { state: p.state }) }
    appRuntime.fireMessage('game', { type: 'player_leave', playerId: clientId })
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
