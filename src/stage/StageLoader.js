import { Stage } from './Stage.js'
import { worldPlayerModel } from '../shared/worldDefaults.js'
import { resolveTerrainConfig } from '../shared/terrainConfig.js'
import { resolveClusterConfig } from '../shared/clusterConfig.js'

function vecOK(v, n) {
  if (!Array.isArray(v) || v.length !== n) return false
  for (let i = 0; i < n; i++) if (!Number.isFinite(v[i])) return false
  return true
}

function stagePlanetRadius(worldDef) {
  const tcfg = resolveTerrainConfig(worldDef)
  const clusterConfig = tcfg
    ? resolveClusterConfig(tcfg.clusters, { radius: tcfg.radius, relevanceRadius: worldDef.relevanceRadius || 200, maxWeaponRangeM: worldDef.maxWeaponRangeM ?? 0 })
    : null
  if (clusterConfig) return clusterConfig.radius
  const declared = worldDef.planetRadius
  if (declared == null || declared === 0) return 0
  throw new TypeError(`[stage] world "${worldDef.name ?? '(unnamed)'}" declares planetRadius ${JSON.stringify(declared)} without enabled clusters: the cube-sphere cell lattice moves every cell query origin onto the sphere while players stay at chart-local distances, so the ring serves nothing and raises nothing -- the radius has to be the one resolveClusterConfig resolves`)
}

export class StageLoader {
  constructor(runtime) {
    this._runtime = runtime
    this._stages = new Map()
    this._activeStage = null
  }

  loadFromDefinition(name, worldDef) {
    const stage = new Stage(name, {
      relevanceRadius: worldDef.relevanceRadius || 200,
      planetRadius: stagePlanetRadius(worldDef),
      gravity: worldDef.gravity,
      spawnPoint: worldDef.spawnPoint,
      playerModel: worldPlayerModel(worldDef)
    })
    stage.bind(this._runtime)

    if (worldDef.gravity) {
      this._runtime.gravity = [...worldDef.gravity]
    }

    for (const entDef of worldDef.entities || []) {
      let declaredBodyType = entDef.bodyType
      if (!declaredBodyType && entDef.app) {
        const appDef = this._runtime._appDefs?.get(entDef.app)
        const appServerDef = appDef?.server || appDef
        declaredBodyType = appServerDef?.bodyType || appDef?.bodyType
      }
      const cfg = {
        model: entDef.model,
        position: vecOK(entDef.position, 3) ? entDef.position : [0, 0, 0],
        rotation: vecOK(entDef.rotation, 4) ? entDef.rotation : undefined,
        scale: vecOK(entDef.scale, 3) ? entDef.scale : undefined,
        app: entDef.app,
        config: entDef.config || null,
        custom: (entDef.custom && typeof entDef.custom === 'object' && !Array.isArray(entDef.custom)) ? entDef.custom : null,
        bodyType: (declaredBodyType === 'dynamic' || declaredBodyType === 'kinematic') ? declaredBodyType : undefined
      }
      if (entDef.model && !entDef.app) {
        cfg.autoTrimesh = true
      }
      stage.addEntity(entDef.id || null, cfg)
    }

    this._stages.set(name, stage)
    if (!this._activeStage) this._activeStage = stage
    return stage
  }

  getStage(name) {
    return this._stages.get(name) || null
  }

  getActiveStage() {
    return this._activeStage
  }

  setActiveStage(name) {
    const stage = this._stages.get(name)
    if (stage) this._activeStage = stage
    return stage
  }

  allStages() {
    return [...this._stages.values()]
  }

  get stageCount() {
    return this._stages.size
  }

  syncAllPositions() {
    for (const stage of this._stages.values()) {
      stage.syncPositions()
    }
  }

  getNearbyEntities(position, radius) {
    if (!this._activeStage) return []
    return this._activeStage.getNearbyEntities(position, radius)
  }

  getRelevantEntities(position, radius) {
    if (!this._activeStage) return []
    return this._activeStage.getRelevantEntities(position, radius)
  }

  getRelevantEntitiesHorizontal(position, radius) {
    if (!this._activeStage) return []
    return this._activeStage.getRelevantEntitiesHorizontal(position, radius)
  }
}
