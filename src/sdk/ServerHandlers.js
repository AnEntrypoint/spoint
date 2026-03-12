import { MSG, DISCONNECT_REASONS } from '../protocol/MessageTypes.js'
import { SnapshotEncoder } from '../netcode/SnapshotEncoder.js'
import { readdirSync, existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

export function createConnectionHandlers(ctx) {
  const { tickSystem, playerManager, networkState, lagCompensator, physicsIntegration, connections, sessions, appLoader, appRuntime, emitter, inspector } = ctx

  function onClientConnect(transport) {
    const spawnPoints = ctx.worldSpawnPoints || [ctx.worldSpawnPoint]
    const sp = [...spawnPoints[Math.floor(Math.random() * spawnPoints.length)]]
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
      const { entities: _ignored, ...worldDefForClient } = ctx.currentWorldDef
      connections.send(playerId, MSG.WORLD_DEF, worldDefForClient)
    }
    const clientModules = appLoader.getClientModules()
    for (const [appName, code] of Object.entries(clientModules)) {
      connections.send(playerId, MSG.APP_MODULE, { app: appName, code })
    }
    const relevanceRadius = ctx.currentWorldDef?.relevanceRadius || 0
    const snapEntities = relevanceRadius > 0 ? appRuntime.getSnapshotForPlayer(sp, relevanceRadius) : appRuntime.getSnapshot()
    const playerSnap = networkState.getSnapshot()
    const combined = { tick: playerSnap.tick, timestamp: playerSnap.timestamp, players: playerSnap.players, entities: snapEntities.entities }
    connections.send(playerId, MSG.SNAPSHOT, { seq: ++ctx.snapshotSeq, ...SnapshotEncoder.encode(combined) })
    for (const [entityId] of appRuntime.apps) appRuntime.fireMessage(entityId, { type: 'player_join', playerId })
    connections.send(playerId, MSG.SCENE_GRAPH, { entities: appRuntime.getSceneGraph() })
    emitter.emit('playerJoin', { id: playerId })
  }

  connections.on('message', (clientId, msg) => {
    if (inspector.handleMessage(clientId, msg)) return
    if (msg.type === MSG.HEARTBEAT) {
      connections.send(clientId, MSG.HEARTBEAT_ACK, { timestamp: msg.payload?.timestamp || Date.now() })
      return
    }
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
      if (playerManager.getPlayer(oldId)) {
        playerManager.removePlayer(oldId)
        networkState.removePlayer(oldId)
        physicsIntegration.removePlayerCollider(oldId)
        lagCompensator.clearPlayerHistory(oldId)
        connections.broadcast(MSG.PLAYER_LEAVE, { playerId: oldId })
      }
      if (clientId !== oldId && playerManager.getPlayer(clientId)) {
        playerManager.removePlayer(clientId)
        networkState.removePlayer(clientId)
        physicsIntegration.removePlayerCollider(clientId)
        lagCompensator.clearPlayerHistory(clientId)
        connections.broadcast(MSG.PLAYER_LEAVE, { playerId: clientId })
      }
      connections.detachClient(clientId)
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
    if (msg.type === MSG.EDITOR_UPDATE) {
      const { entityId, changes } = msg.payload || {}
      if (entityId && changes) {
        const entity = appRuntime.entities.get(entityId)
        if (entity) {
          if (changes.position) entity.position = changes.position
          if (changes.rotation) entity.rotation = changes.rotation
          if (changes.scale) entity.scale = changes.scale
          if (changes.custom) entity.custom = { ...entity.custom, ...changes.custom }
          appRuntime.fireEvent(entityId, 'onEditorUpdate', changes)
          ctx.placedModelStorage?.persist(appRuntime)
        }
      }
      return
    }
    if (msg.type === MSG.PLACE_MODEL) {
      const { url, position } = msg.payload || {}
      if (url) {
        const id = 'placed-' + Math.random().toString(36).slice(2, 10)
        const entity = appRuntime.spawnEntity(id, { model: url, position: position || [0,0,0], app: 'placed-model', config: { collider: 'none' } })
        connections.send(clientId, MSG.EDITOR_SELECT, { entityId: id })
        ctx.placedModelStorage?.persist(appRuntime)
      }
      return
    }
    if (msg.type === MSG.PLACE_APP) {
      const { appName, position, config } = msg.payload || {}
      if (appName && appRuntime._appDefs.has(appName)) {
        const id = appName + '-' + Math.random().toString(36).slice(2, 8)
        appRuntime.spawnEntity(id, { app: appName, position: position || [0,0,0], config: config || {} })
        const entity = appRuntime.entities.get(id)
        const appDef = appRuntime._appDefs.get(appName)
        const editorProps = (appDef?.server || appDef)?.editorProps || appDef?.editorProps || []
        connections.send(clientId, MSG.EDITOR_SELECT, { entityId: id, editorProps })
        ctx.placedModelStorage?.persist(appRuntime)
      }
      return
    }
    if (msg.type === MSG.LIST_APPS) {
      const appsRoot = resolve(process.cwd(), 'apps')
      const apps = []
      try {
        for (const name of readdirSync(appsRoot)) {
          const idxPath = join(appsRoot, name, 'index.js')
          if (!existsSync(idxPath)) continue
          const src = readFileSync(idxPath, 'utf8')
          const descMatch = src.match(/\/\/\s*(.+)/)
          const description = descMatch ? descMatch[1].trim() : ''
          const appDef = appRuntime._appDefs.get(name)
          const serverMod = appDef?.server || appDef
          const hasEditorProps = !!(serverMod?.editorProps?.length)
          apps.push({ name, description, hasEditorProps })
        }
      } catch (e) { /* ignore */ }
      connections.send(clientId, MSG.APP_LIST, { apps })
      return
    }
    if (msg.type === MSG.LIST_APP_FILES) {
      const { appName } = msg.payload || {}
      if (appName) {
        const appsRoot = resolve(process.cwd(), 'apps')
        const appDir = resolve(join(appsRoot, appName))
        if (appDir.startsWith(appsRoot) && existsSync(appDir)) {
          const files = []
          const scan = (dir, prefix) => {
            try {
              for (const entry of readdirSync(dir)) {
                const full = join(dir, entry)
                const rel = prefix ? prefix + '/' + entry : entry
                if (statSync(full).isDirectory()) { scan(full, rel) }
                else { files.push(rel) }
              }
            } catch (e) { /* ignore */ }
          }
          scan(appDir, '')
          connections.send(clientId, MSG.APP_FILES, { appName, files })
        }
      }
      return
    }
    if (msg.type === MSG.GET_SOURCE) {
      const { appName, file } = msg.payload || {}
      if (appName) {
        const appsRoot = resolve(process.cwd(), 'apps')
        const filePath = resolve(join(appsRoot, appName, file || 'index.js'))
        if (filePath.startsWith(appsRoot) && existsSync(filePath)) {
          const source = readFileSync(filePath, 'utf8')
          connections.send(clientId, MSG.SOURCE, { appName, file: file || 'index.js', source })
        }
      }
      return
    }
    if (msg.type === MSG.SAVE_SOURCE) {
      const { appName, file, source } = msg.payload || {}
      if (appName && source != null) {
        const appsRoot = resolve(process.cwd(), 'apps')
        const filePath = resolve(join(appsRoot, appName, file || 'index.js'))
        if (filePath.startsWith(appsRoot)) {
          writeFileSync(filePath, source, 'utf8')
          connections.send(clientId, MSG.SOURCE, { appName, file: file || 'index.js', source })
        }
      }
      return
    }
    if (msg.type === MSG.SCENE_GRAPH) {
      connections.send(clientId, MSG.SCENE_GRAPH, { entities: appRuntime.getSceneGraph() })
      return
    }
    if (msg.type === MSG.DESTROY_ENTITY) {
      const { entityId } = msg.payload || {}
      if (entityId && appRuntime.entities.has(entityId)) {
        appRuntime.destroyEntity(entityId)
        ctx.placedModelStorage?.persist(appRuntime)
        connections.broadcast(MSG.DESTROY_ENTITY, { entityId })
      }
      return
    }
    if (msg.type === MSG.GET_EDITOR_PROPS) {
      const { entityId } = msg.payload || {}
      if (entityId) {
        const entity = appRuntime.entities.get(entityId)
        const appName = entity?._appName
        const appDef = appName ? appRuntime._appDefs.get(appName) : null
        const serverMod = appDef?.server || appDef
        const editorProps = serverMod?.editorProps || []
        connections.send(clientId, MSG.EDITOR_PROPS, { entityId, editorProps })
      }
      return
    }
    if (msg.type === MSG.CREATE_APP) {
      const { appName } = msg.payload || {}
      if (!appName || !/^[a-z0-9-]+$/.test(appName)) return
      const appsRoot = resolve(process.cwd(), 'apps')
      const appDir = join(appsRoot, appName)
      if (!existsSync(appDir)) {
        mkdirSync(appDir, { recursive: true })
        const template = `export default {
  server: {
    // editorProps: [
    //   { key: 'color', label: 'Color', type: 'color', default: '#ffffff' },
    //   { key: 'size', label: 'Size', type: 'number', default: 1 },
    // ],
    setup(ctx) {
      // Entity is ready — set up physics, state, etc.
      // ctx.physics.addColliderFromConfig({ type: 'box', size: [0.5, 0.5, 0.5] })
      // ctx.interactable({ prompt: 'Press E', radius: 3 })
    },
    onEditorUpdate(ctx, changes) {
      if (changes.position) ctx.entity.position = changes.position
      if (changes.rotation) ctx.entity.rotation = changes.rotation
      if (changes.scale) ctx.entity.scale = changes.scale
      if (changes.custom) ctx.entity.custom = { ...ctx.entity.custom, ...changes.custom }
    }
  },
  client: {
    render(ctx) {
      return { position: ctx.entity.position, rotation: ctx.entity.rotation, scale: ctx.entity.scale, model: ctx.entity.model }
    }
  }
}
`
        writeFileSync(join(appDir, 'index.js'), template, 'utf8')
        connections.send(clientId, MSG.SOURCE, { appName, file: 'index.js', source: template })
      }
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
