export function mixinTick(runtime) {
  runtime.tick = function(tickNum, dt) {
    this.currentTick = tickNum; this.deltaTime = dt; this.elapsed += dt
    if (tickNum % this._entityTickDivisor === 0) {
      const entityDt = dt * this._entityTickDivisor
      for (const {id: entityId, update, ctx} of this._updateList) {
        try { const r = update(ctx, entityDt); if (r?.catch) r.catch(e => console.error(`[AppRuntime] update(${entityId}): ${e.message}`)) }
        catch (e) { console.error(`[AppRuntime] update(${entityId}): ${e.message}`) }
      }
    }
    this._tickTimers(dt)
    const _ts0 = performance.now()
    this._syncDynamicBodies()
    const players = this.getPlayers()
    if (tickNum % this._physicsLODInterval === 0) this._tickPhysicsLOD(players)
    this._lastSyncMs = performance.now() - _ts0
    const _ts1 = performance.now()
    this._tickRespawn()
    this._lastRespawnMs = performance.now() - _ts1
    const _ts2 = performance.now()
    this._spatialSync()
    this._syncPlayerIndex()
    this._lastSpatialMs = performance.now() - _ts2
    const _ts3 = performance.now()
    this._tickCollisions()
    this._lastCollisionMs = performance.now() - _ts3
    const _ts4 = performance.now()
    this._tickInteractables()
    this._lastInteractMs = performance.now() - _ts4
  }

  runtime._tickTimers = function(dt) {
    for (const [eid, timers] of this._timers) {
      const keep = []
      for (const t of timers) {
        t.remaining -= dt
        if (t.remaining <= 0) { try { t.fn() } catch (e) { console.error(`[AppRuntime] timer(${eid}):`, e.message) }; if (t.repeat) { t.remaining = t.interval; keep.push(t) } }
        else keep.push(t)
      }
      if (keep.length) this._timers.set(eid, keep); else this._timers.delete(eid)
    }
  }

  runtime._colR = function(c) {
    if (!c) return 0
    if (c._cachedRadius !== undefined) return c._cachedRadius
    let r = 0
    if (c.type === 'sphere') r = c.radius || 1
    else if (c.type === 'capsule') r = Math.max(c.radius || 0.5, (c.height || 1) / 2)
    else if (c.type === 'box') {
      const s = c.size; const h = c.halfExtents
      if (Array.isArray(s)) r = Math.max(...s)
      else if (typeof s === 'number') r = s
      else if (Array.isArray(h)) r = Math.max(...h)
      else r = 1
    } else r = 1
    c._cachedRadius = r
    return r
  }

  const _colGrid = new Map()
  const _colGridCells = new Map()
  const _COL_GRID_THRESHOLD = 100
  const _COL_CELL_SZ = 4

  runtime._tickCollisions = function() {
    const c = this._collisionEntities
    if (c.length === 0) return
    for (let i = 0; i < c.length; i++) c[i]._cachedColR = this._colR(c[i].collider)
    if (c.length < _COL_GRID_THRESHOLD) {
      this._tickCollisionsBrute(c)
    } else {
      this._tickCollisionsGrid(c)
    }
  }

  runtime._tickCollisionsBrute = function(c) {
    for (let i = 0; i < c.length; i++) {
      const a = c[i], ar = a._cachedColR, ax = a.position[0], ay = a.position[1], az = a.position[2]
      for (let j = i + 1; j < c.length; j++) {
        const b = c[j], dx = b.position[0]-ax, dy = b.position[1]-ay, dz = b.position[2]-az
        const rr = ar + b._cachedColR
        if (dx*dx+dy*dy+dz*dz < rr*rr) {
          this.fireEvent(a.id, 'onCollision', { id: b.id, position: b.position, velocity: b.velocity })
          this.fireEvent(b.id, 'onCollision', { id: a.id, position: a.position, velocity: a.velocity })
        }
      }
    }
  }

  runtime._tickCollisionsGrid = function(c) {
    _colGrid.clear()
    for (let i = 0; i < c.length; i++) {
      const e = c[i]
      const key = Math.floor(e.position[0] / _COL_CELL_SZ) * 65536 + Math.floor(e.position[2] / _COL_CELL_SZ)
      let cell = _colGrid.get(key)
      if (!cell) { cell = _colGridCells.get(key); if (!cell) { cell = []; _colGridCells.set(key, cell) } else { cell.length = 0 }; _colGrid.set(key, cell) }
      cell.push(e)
    }
    for (let i = 0; i < c.length; i++) {
      const a = c[i], ar = a._cachedColR, ax = a.position[0], ay = a.position[1], az = a.position[2]
      const acx = Math.floor(ax / _COL_CELL_SZ), acz = Math.floor(az / _COL_CELL_SZ)
      for (let ddx = -1; ddx <= 1; ddx++) for (let ddz = -1; ddz <= 1; ddz++) {
        const cell = _colGrid.get((acx + ddx) * 65536 + (acz + ddz))
        if (!cell) continue
        for (const b of cell) {
          if (b.id <= a.id) continue
          const dx = b.position[0]-ax, dy = b.position[1]-ay, dz = b.position[2]-az
          const rr = ar + b._cachedColR
          if (dx*dx+dy*dy+dz*dz < rr*rr) {
            this.fireEvent(a.id, 'onCollision', { id: b.id, position: b.position, velocity: b.velocity })
            this.fireEvent(b.id, 'onCollision', { id: a.id, position: a.position, velocity: a.velocity })
          }
        }
      }
    }
  }

  runtime._tickRespawn = function() {
    const now = Date.now()
    for (const id of this._activeDynamicIds) {
      const e = this.entities.get(id); if (!e) continue
      if (e.position[1] < -20) {
        if (!this._respawnTimer.has(id)) this._respawnTimer.set(id, { startTime: now, lastRespawn: 0 })
        const timer = this._respawnTimer.get(id)
        if ((now - timer.startTime) / 1000 >= 5 && now - timer.lastRespawn >= 1000) {
          const spawnPos = e._spawnPosition || [0, 20, 0]
          e.position[0] = spawnPos[0]; e.position[1] = spawnPos[1]; e.position[2] = spawnPos[2]
          e.velocity[0] = 0; e.velocity[1] = 0; e.velocity[2] = 0
          if (e._physicsBodyId !== undefined && this._physics) {
            this._physics.setBodyPosition(e._physicsBodyId, spawnPos)
            this._physics.setBodyVelocity(e._physicsBodyId, [0, 0, 0])
          }
          timer.startTime = now; timer.lastRespawn = now
        }
      } else {
        this._respawnTimer.delete(id)
      }
    }
  }

  runtime._tickInteractables = function() {
    if (this._interactableIds.size === 0) return
    const now = Date.now()
    const players = this.getPlayers()
    for (const id of this._interactableIds) {
      const e = this.entities.get(id); if (!e || !e._interactable) continue
      for (const p of players) {
        const pp = p.state?.position; if (!pp) continue
        const dx = pp[0]-e.position[0], dy = pp[1]-e.position[1], dz = pp[2]-e.position[2]
        if (dx*dx+dy*dy+dz*dz > e._interactRadius**2) continue
        const key = e.id * 100000 + p.id
        const last = this._interactCooldowns.get(key) || 0
        const cooldown = e._interactCooldown ?? 500
        if (p.lastInput?.interact && now - last > cooldown) {
          this._interactCooldowns.set(key, now)
          this.fireEvent(e.id, 'onInteract', p)
          const bus = this._eventBus.scope ? this._eventBus : null
          if (bus) bus.emit(`interact.${e.id}`, { player: p, entity: e })
        }
      }
    }
  }

  runtime._syncPlayerIndex = function() {
    const players = this.getPlayers()
    const ids = this._playerIndexIds
    ids.clear()
    for (const p of players) {
      const pos = p.state?.position
      if (pos) this._playerIndex.update(p.id, pos)
      ids.add(p.id)
    }
    if (this._playerIndex.size > players.length) {
      for (const id of [...this._playerIndex._entities.keys()]) {
        if (!ids.has(id)) this._playerIndex.remove(id)
      }
    }
  }

  runtime.getNearbyPlayers = function(viewerPosition, radius, allPlayers) {
    if (!allPlayers || allPlayers.length === 0) return []
    if (this._playerIndex.size === 0) {
      const cx = viewerPosition[0], cy = viewerPosition[1], cz = viewerPosition[2]
      const r2 = radius * radius
      return allPlayers.filter(p => { const dx=p.position[0]-cx,dy=p.position[1]-cy,dz=p.position[2]-cz; return dx*dx+dy*dy+dz*dz<=r2 })
    }
    const nearbyIds = new Set(this._playerIndex.nearby(viewerPosition, radius))
    return allPlayers.filter(p => nearbyIds.has(p.id))
  }
}
