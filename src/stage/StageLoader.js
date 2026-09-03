import { Stage } from './Stage.js'

// world defs are untrusted input -- validate position/scale here so a malformed value falls back safely instead of NaN-poisoning the broadcast snapshot
function vecOK(v, n) {
  if (!Array.isArray(v) || v.length !== n) return false
  for (let i = 0; i < n; i++) if (!Number.isFinite(v[i])) return false
  return true
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
      planetRadius: worldDef.planetRadius || 0,
      gravity: worldDef.gravity,
      spawnPoint: worldDef.spawnPoint,
      playerModel: worldDef.playerModel
    })
    stage.bind(this._runtime)

    if (worldDef.gravity) {
      this._runtime.gravity = [...worldDef.gravity]
    }

    for (const entDef of worldDef.entities || []) {
      const cfg = {
        model: entDef.model,
        position: vecOK(entDef.position, 3) ? entDef.position : [0, 0, 0],
        rotation: vecOK(entDef.rotation, 4) ? entDef.rotation : undefined,
        scale: vecOK(entDef.scale, 3) ? entDef.scale : undefined,
        app: entDef.app,
        config: entDef.config || null,
        // must copy entDef.custom or world-def-authored custom fields (e.g. _interior) never reach the spawned entity
        custom: (entDef.custom && typeof entDef.custom === 'object' && !Array.isArray(entDef.custom)) ? entDef.custom : null,
        // same class of bug as the custom-field drop above: a world-def-declared bodyType (e.g. a
        // scripted/kinematic entity meant to be 'dynamic') was silently discarded here, so every
        // world-def entity always spawned as AppRuntime.spawnEntity's 'static' default regardless of
        // what the world def actually declared -- found while live-witnessing bug-otb-ball-sync-rootcause.
        bodyType: (entDef.bodyType === 'dynamic' || entDef.bodyType === 'kinematic') ? entDef.bodyType : undefined
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
}
