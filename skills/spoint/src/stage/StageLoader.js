import { Stage } from './Stage.js'

export class StageLoader {
  constructor(runtime) {
    this._runtime = runtime
    this._stages = new Map()
    this._activeStage = null
  }

  loadFromDefinition(name, worldDef) {
    const stage = new Stage(name, {
      relevanceRadius: worldDef.relevanceRadius || 200,
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
        position: entDef.position || [0, 0, 0],
        rotation: entDef.rotation,
        scale: entDef.scale,
        app: entDef.app,
        config: entDef.config || null
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

  removeStage(name) {
    const stage = this._stages.get(name)
    if (!stage) return
    stage.clear()
    this._stages.delete(name)
    if (this._activeStage === stage) {
      this._activeStage = this._stages.values().next().value || null
    }
  }

  swapStage(oldName, newName, newDef) {
    this.removeStage(oldName)
    return this.loadFromDefinition(newName, newDef)
  }

  getAllStageNames() {
    return Array.from(this._stages.keys())
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
