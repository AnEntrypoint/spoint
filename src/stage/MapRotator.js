import { EventBus } from '../apps/EventBus.js'

export class MapRotator {
  constructor(options = {}) {
    this.maps = options.maps || []
    this.interval = options.interval || 300000
    this.stageLoader = options.stageLoader || null
    this.runtime = options.runtime || null
    this.eventBus = options.eventBus || new EventBus()
    
    this.currentIndex = 0
    this.timer = null
    this.running = false
    this.spawnPoints = new Map()
    this.currentMapEntityId = 'environment'
    this.pendingSwap = false
  }

  start() {
    if (this.running || this.maps.length === 0) return
    this.running = true
    this.timer = setInterval(() => this.next(), this.interval)
    this.eventBus.emit('maprotator.started', { 
      maps: this.maps, 
      interval: this.interval,
      startIndex: this.currentIndex 
    })
  }

  stop() {
    if (!this.running) return
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.eventBus.emit('maprotator.stopped', { currentIndex: this.currentIndex })
  }

  async next() {
    if (this.pendingSwap || this.maps.length === 0) return null
    
    const oldIndex = this.currentIndex
    this.currentIndex = (this.currentIndex + 1) % this.maps.length
    const newMap = this.maps[this.currentIndex]
    
    this.pendingSwap = true
    this.eventBus.emit('maprotator.changing', {
      fromIndex: oldIndex,
      toIndex: this.currentIndex,
      fromMap: this.maps[oldIndex],
      toMap: newMap
    })
    
    try {
      await this._swapMap(newMap)
      this.eventBus.emit('maprotator.changed', {
        index: this.currentIndex,
        map: newMap,
        spawnPoints: this.spawnPoints.get(newMap) || []
      })
    } catch (err) {
      console.error(`[MapRotator] Failed to swap to ${newMap}:`, err.message)
      this.currentIndex = oldIndex
      this.eventBus.emit('maprotator.error', { 
        map: newMap, 
        error: err.message 
      })
    } finally {
      this.pendingSwap = false
    }
    
    return newMap
  }

  async _swapMap(mapPath) {
    if (!this.runtime || !this.stageLoader) {
      throw new Error('MapRotator not properly initialized with runtime/stageLoader')
    }
    
    const stage = this.stageLoader.getActiveStage()
    if (!stage) {
      throw new Error('No active stage')
    }
    
    const oldEntity = this.runtime.getEntity(this.currentMapEntityId)
    if (oldEntity) {
      if (oldEntity._physicsBodyId !== undefined && this.runtime._physics) {
        this.runtime._physics.removeBody(oldEntity._physicsBodyId)
        oldEntity._physicsBodyId = undefined
      }
      this.runtime.destroyEntity(this.currentMapEntityId)
    }
    
    for (const id of stage.getAllEntityIds()) {
      const e = this.runtime.getEntity(id)
      if (e && e.model === mapPath) continue
    }
    
    const entity = this.runtime.spawnEntity(this.currentMapEntityId, {
      model: mapPath,
      position: [0, 0, 0],
      app: 'environment',
      autoTrimesh: true
    })
    
    if (!entity) {
      throw new Error(`Failed to spawn entity for map ${mapPath}`)
    }
    
    stage.entityIds.add(entity.id)
    stage._staticIds.add(entity.id)
    stage.spatial.insert(entity.id, entity.position)
    
    await this._waitForPhysicsLoad(entity)
    
    const spawnPoints = await this._findSpawnPoints(mapPath)
    this.spawnPoints.set(mapPath, spawnPoints)
  }

  async _waitForPhysicsLoad(entity, timeout = 30000) {
    const start = Date.now()
    while (!entity._physicsBodyId && Date.now() - start < timeout) {
      await new Promise(r => setTimeout(r, 100))
    }
    if (!entity._physicsBodyId) {
      console.warn(`[MapRotator] Physics body not loaded for ${entity.model}, continuing anyway`)
    }
  }

  async _findSpawnPoints(mapPath) {
    if (!this.runtime || !this.runtime._physics) {
      return [[0, 5, 0]]
    }
    
    const cached = this.spawnPoints.get(mapPath)
    if (cached && cached.length > 0) return cached
    
    const valid = []
    const gridSize = 15
    const searchRadius = 100
    const rayHeight = 50
    const rayDistance = 60
    const minY = -10
    
    for (let x = -searchRadius; x <= searchRadius; x += gridSize) {
      for (let z = -searchRadius; z <= searchRadius; z += gridSize) {
        const hit = this.runtime._physics.raycast([x, rayHeight, z], [0, -1, 0], rayDistance)
        if (hit && hit.hit && hit.position && hit.position[1] > minY) {
          valid.push([x, hit.position[1] + 1.5, z])
        }
      }
    }
    
    if (valid.length < 4) {
      valid.push([0, 5, 0], [10, 5, 10], [-10, 5, -10], [10, 5, -10])
    }
    
    return valid
  }

  getCurrentMap() {
    if (this.maps.length === 0) return null
    return this.maps[this.currentIndex] || null
  }

  getMapIndex() {
    return this.currentIndex
  }

  getSpawnPoints(mapPath) {
    const path = mapPath || this.getCurrentMap()
    return this.spawnPoints.get(path) || [[0, 5, 0]]
  }

  getAllSpawnPoints() {
    return new Map(this.spawnPoints)
  }

  getMapCount() {
    return this.maps.length
  }

  isRunning() {
    return this.running
  }
}
