import { MSG } from '../../protocol/MessageTypes.js'
import { pack } from '../../protocol/msgpack.js'

export class SnapshotSystem {
  constructor(deps) {
    this.deps = deps; this.playerEntityMaps = new Map(); this.broadcastEntityMap = new Map()
    this.staticEntityMap = new Map(); this.staticEntityIds = new Set(); this.lastStaticEntries = null; this.lastStaticVersion = -1
    this.prevDynCache = null; this.snapshotSeq = 0
  }

  send(tick, players, playerSnap, allPreEncodedPlayers, snapGroups, curGroup, isKeyframe, grid) {
    const { appRuntime, stageLoader, getRelevanceRadius, connections, SnapshotEncoder } = this.deps
    const relevanceRadius = (stageLoader && stageLoader.getActiveStage()) ? stageLoader.getActiveStage().spatial.relevanceRadius : (getRelevanceRadius ? getRelevanceRadius() : 0)
    const serverTime = Date.now(); const useSpatial = relevanceRadius > 0 && relevanceRadius < 400
    if (useSpatial) {
      const curStaticVersion = appRuntime._staticVersion
      if (isKeyframe || curStaticVersion !== this.lastStaticVersion) {
        const allEntitiesRaw = appRuntime.getAllEntities(); const prevStaticMap = isKeyframe ? new Map() : this.staticEntityMap
        const { staticEntries, staticMap, staticChanged } = SnapshotEncoder.encodeStaticEntities(allEntitiesRaw, prevStaticMap)
        this.lastStaticEntries = staticEntries; if (staticChanged || isKeyframe) { this.staticEntityMap = staticMap; this.staticEntityIds = SnapshotEncoder.buildStaticIds(staticMap) }
        this.lastStaticVersion = curStaticVersion
      }
      const activeDynCount = appRuntime._activeDynamicIds.size; let dynCache
      if (activeDynCount === 0 && this.prevDynCache !== null) dynCache = this.prevDynCache
      else if (this.prevDynCache !== null && activeDynCount < this.prevDynCache.size * 0.1) { dynCache = SnapshotEncoder.updateDynamicCache(this.prevDynCache, appRuntime._activeDynamicIds, appRuntime.entities); this.prevDynCache = dynCache }
      else { dynCache = SnapshotEncoder.encodeDynamicEntitiesOnce(appRuntime.getDynamicEntities(), this.prevDynCache); this.prevDynCache = dynCache }
      const pMap = new Map(); const pMapEnc = new Map()
      for (let i = 0; i < playerSnap.players.length; i++) { const p = playerSnap.players[i]; pMap.set(p.id, p); pMapEnc.set(allPreEncodedPlayers[i][0], allPreEncodedPlayers[i]) }
      for (let i = 0; i < players.length; i++) {
        const p = players[i]; if (p.id % snapGroups !== curGroup) continue
        const isNew = !this.playerEntityMaps.has(p.id), relIds = appRuntime.getRelevantDynamicIds(p.state.position, relevanceRadius)
        const nearby = appRuntime.getNearbyPlayers(p.state.position, relevanceRadius, playerSnap.players, grid, pMap)
        const preEncP = new Array(nearby.length); for (let j=0; j<nearby.length; j++) preEncP[j] = pMapEnc.get(nearby[j].id)
        const prevM = isNew ? new Map() : this.playerEntityMaps.get(p.id)
        let filteredRelIds = null
        if (relIds) {
          filteredRelIds = new Set()
          const px = p.state.position[0], pz = p.state.position[2]
          const hRad2 = (relevanceRadius * 0.3) ** 2, mRad2 = (relevanceRadius * 0.6) ** 2
          for (const id of relIds) {
            const e = appRuntime.entities.get(id); if (!e) continue
            const ex = e.position[0], ez = e.position[2], dx = ex - px, dz = ez - pz, d2 = dx*dx + dz*dz
            if (d2 < hRad2 || (d2 < mRad2 && tick % 2 === 0) || (tick % 4 === 0)) filteredRelIds.add(id)
          }
        }
        const { encoded, entityMap } = SnapshotEncoder.encodeDeltaFromCache(playerSnap.tick, serverTime, dynCache, filteredRelIds, prevM, preEncP, isNew ? this.lastStaticEntries : null, this.staticEntityIds)
        this.playerEntityMaps.set(p.id, entityMap)
        connections.send(p.id, MSG.SNAPSHOT, { seq: this.snapshotSeq, ...encoded })
      }
    } else {
      const prevMap = (isKeyframe || this.broadcastEntityMap.size === 0) ? new Map() : this.broadcastEntityMap
      const { encoded, entityMap } = SnapshotEncoder.encodeDeltaFromCache(playerSnap.tick, serverTime, this.prevDynCache || new Map(), null, prevMap, allPreEncodedPlayers, this.lastStaticEntries, this.staticEntityIds)
      this.broadcastEntityMap = entityMap;
      const data = pack({ type: MSG.SNAPSHOT, payload: { seq: this.snapshotSeq, ...encoded } })
      for (let i = 0; i < players.length; i++) { if (isKeyframe || players[i].id % snapGroups === curGroup) connections.sendPacked(players[i].id, data, true) }
    }
  }
  cleanup(playerManager) { for (const id of this.playerEntityMaps.keys()) { if (!playerManager.getPlayer(id)) this.playerEntityMaps.delete(id) } }
}
