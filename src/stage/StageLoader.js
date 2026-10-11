import { Stage } from './Stage.js'
import { worldPlayerModel } from '../shared/worldDefaults.js'
import { resolveTerrainConfig } from '../shared/terrainConfig.js'
import { resolveClusterConfig, declaredWeaponRangeM } from '../shared/clusterConfig.js'
import { flatPlanetRadius, clusterPlanetRadius } from './planetRadius.js'

export class StageConfigError extends TypeError {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.name = 'StageConfigError'
    this.code = code
  }
}

function vecOK(v, n) {
  if (!Array.isArray(v) || v.length !== n) return false
  for (let i = 0; i < n; i++) if (!Number.isFinite(v[i])) return false
  return true
}

function stagePlanetRadius(worldDef, appDefs) {
  const worldName = worldDef.name ?? '(unnamed)'
  const tcfg = resolveTerrainConfig(worldDef)
  if (tcfg && tcfg.clusters && tcfg.clusters.enabled === true && !(Number.isFinite(tcfg.radius) && tcfg.radius > 0)) {
    throw new StageConfigError('stage-cluster-needs-planet-radius', `[stage] world "${worldName}" enables clusters on terrain radius ${JSON.stringify(tcfg.radius ?? null)}: a cluster world is one chart-anchor lattice over one positive finite radius, so the stage refuses the request at the entry instead of letting the lattice raise downstream with no world named`)
  }
  let clusterConfig = null
  if (tcfg) {
    try {
      clusterConfig = resolveClusterConfig(tcfg.clusters, { radius: tcfg.radius, relevanceRadius: worldDef.relevanceRadius || 200, maxWeaponRangeM: declaredWeaponRangeM(worldDef, appDefs) })
    } catch (e) {
      throw new StageConfigError('stage-cluster-config-refused', `[stage] world "${worldName}" carries a cluster config the cluster resolver refuses (${e?.code ?? e?.name ?? 'unnamed'}: ${e?.message ?? e}): the stage owns one radius per world and reports the refusal in its own vocabulary, so a caller never has to know which module drew the line`)
    }
  }
  if (clusterConfig) {
    const declared = worldDef.planetRadius
    if (declared != null && declared !== 0 && declared !== clusterConfig.radius) {
      throw new StageConfigError('stage-radius-conflicts-with-cluster-radius', `[stage] world "${worldName}" declares planetRadius ${JSON.stringify(declared)} while its enabled clusters resolve ${clusterConfig.radius}: one world has one radius and the cluster-resolved one is the one that moves every cell query origin, so a second declared value is a disagreement the stage refuses instead of discarding`)
    }
    return clusterPlanetRadius(clusterConfig.radius)
  }
  const declared = worldDef.planetRadius
  if (declared == null || declared === 0) return flatPlanetRadius()
  throw new StageConfigError('stage-radius-not-cluster-resolved', `[stage] world "${worldName}" declares planetRadius ${JSON.stringify(declared)} without enabled clusters: the cube-sphere cell lattice moves every cell query origin onto the sphere while players stay at chart-local distances, so the ring serves nothing and raises nothing -- the radius has to be the one resolveClusterConfig resolves`)
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
      planetRadius: stagePlanetRadius(worldDef, this._runtime?._appDefs ?? null),
      shape: worldDef.shape ?? null,
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

  getRelevantEntitiesForCell(position, radius) {
    if (!this._activeStage) return []
    return this._activeStage.getRelevantEntitiesForCell(position, radius)
  }
}
