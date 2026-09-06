const _PROFILE = typeof process !== 'undefined' && !!process.env?.GM_PROFILE

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
    if (!_PROFILE) {
      this._syncDynamicBodies()
      const players = this.getPlayers()
      if (tickNum % this._physicsLODInterval === 0) this._tickPhysicsLOD(players)
      this._tickRespawn()
      this._spatialSync(); this._syncPlayerIndex()
      this._tickCollisions()
      this._tickInteractables()
      this._tickProximityWatches(players)
      this._tickPlayerContactWatches(players)
      this._tickAttachments()
      return
    }
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
    const _ts5 = performance.now()
    this._tickProximityWatches(players)
    this._tickPlayerContactWatches(players)
    this._tickAttachments()
    this._lastProximityMs = performance.now() - _ts5
  }

  runtime._tickTimers = function(dt) {
    for (const [eid, timers] of this._timers) {
      let writeIdx = 0
      for (let i = 0; i < timers.length; i++) {
        const t = timers[i]
        t.remaining -= dt
        if (t.remaining <= 0) { try { t.fn() } catch (e) { console.error(`[AppRuntime] timer(${eid}):`, e.message) }; if (t.repeat) { t.remaining = t.interval; timers[writeIdx++] = t } }
        else timers[writeIdx++] = t
      }
      if (writeIdx === 0) this._timers.delete(eid)
      else timers.length = writeIdx
    }
  }

  runtime._colR = function(c) {
    if (!c) return 0
    if (c._cachedRadius !== undefined) return c._cachedRadius
    let r = 1
    if (c.type === 'sphere') r = c.radius || 1
    else if (c.type === 'capsule') r = Math.max(c.radius || 0.5, (c.height || 1) / 2)
    else if (c.type === 'box') { const s = c.size, h = c.halfExtents; r = Array.isArray(s) ? Math.max(...s) : typeof s === 'number' ? s : Array.isArray(h) ? Math.max(...h) : 1 }
    c._cachedRadius = r; return r
  }

  const _colGrid = new Map()
  const _colGridCells = new Map()
  // below this collider count, O(n^2) brute pass wins; above, the uniform grid amortizes
  const _COL_GRID_THRESHOLD = 100
  const _COL_CELL_SZ = 4
  let _colPruneTick = 0

  runtime._tickCollisions = function() {
    const c = this._collisionEntities; if (c.length === 0) return
    for (let i = 0; i < c.length; i++) c[i]._cachedColR = this._colR(c[i].collider)
    if (c.length < _COL_GRID_THRESHOLD) this._tickCollisionsBrute(c); else this._tickCollisionsGrid(c)
  }

  // Contact payload for `self`'s onCollision when it touches `other`. Beyond the other body's id/position/velocity
  // it carries a contact `point` (surface midpoint between the two centres), a unit `normal` pointing from other
  // toward self, and `impactSpeed` = the closing relative speed along that normal (>0 = approaching, the "how hard
  // did it hit" a golf/basketball/dodgeball/tower-topple game reads). Approximated from centres + linear velocity
  // (bounding-sphere collision, no per-vertex Jolt manifold), which is what the placement/gameplay layer needs.
  runtime._collisionPayload = function(self, other) {
    const sx=self.position, ox=other.position
    let nx=sx[0]-ox[0], ny=sx[1]-ox[1], nz=sx[2]-ox[2]
    const dl = Math.hypot(nx,ny,nz) || 1e-6
    nx/=dl; ny/=dl; nz/=dl
    const sr = self._cachedColR||0
    const point = [sx[0]-nx*sr, sx[1]-ny*sr, sx[2]-nz*sr]
    const sv=self.velocity||[0,0,0], ov=other.velocity||[0,0,0]
    const rvx=sv[0]-ov[0], rvy=sv[1]-ov[1], rvz=sv[2]-ov[2]
    const impactSpeed = -(rvx*nx+rvy*ny+rvz*nz)   // closing speed along the normal
    return { id: other.id, position: other.position, velocity: other.velocity, point, normal:[nx,ny,nz], impactSpeed }
  }

  runtime._tickCollisionsBrute = function(c) {
    for (let i = 0; i < c.length; i++) {
      const a = c[i], ar = a._cachedColR, ax = a.position[0], ay = a.position[1], az = a.position[2]
      for (let j = i + 1; j < c.length; j++) {
        const b = c[j], dx = b.position[0]-ax, dy = b.position[1]-ay, dz = b.position[2]-az
        const rr = ar + b._cachedColR
        if (dx*dx+dy*dy+dz*dz < rr*rr) {
          this.fireEvent(a.id, 'onCollision', this._collisionPayload(a, b))
          this.fireEvent(b.id, 'onCollision', this._collisionPayload(b, a))
        }
      }
    }
  }

  runtime._tickCollisionsGrid = function(c) {
    _colGrid.clear()
    if ((++_colPruneTick & 63) === 0 || _colGridCells.size > c.length * 4) {
      for (const k of _colGridCells.keys()) { if (!_colGrid.has(k)) _colGridCells.delete(k) }
    }
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
            this.fireEvent(a.id, 'onCollision', this._collisionPayload(a, b))
            this.fireEvent(b.id, 'onCollision', this._collisionPayload(b, a))
          }
        }
      }
    }
  }

  runtime._tickRespawn = function() {
    // Date.now() is read lazily, only once some active body is actually below the kill-plane -- the
    // common no-fallen-bodies tick never touches the clock (was one syscall per tick unconditionally).
    let now = 0
    for (const id of this._activeDynamicIds) {
      const e = this.entities.get(id); if (!e) continue
      if (e.position[1] < -20) {
        if (now === 0) now = Date.now()
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

  let _interactPruneTick = 0

  // _interactCooldowns is keyed by `runtime.currentTick` (a resimulate-safe simulation-tick number),
  // NOT Date.now() wall-clock -- a GGPO-style rewind+resimulate pass restores every other piece of
  // gamestate to its tick-N value then re-runs ticks N+1..M using the SAME per-tick dt sequence the
  // original run used (see RollbackLoop.resimulateFrom); a tick-indexed "expires at tick X" value
  // replays identically on both the original run and every resimulate pass, unlike a Date.now() ms
  // timestamp which is compared against whatever the REAL clock happens to read at resimulate time
  // (necessarily later than the original run's clock, corrupting the expired-or-not decision).
  // The per-entity ms cooldown is converted to a tick count using `this.deltaTime`, the SAME dt value
  // driving the current tick() call on both the original pass and any resimulate pass -- so the
  // ms-to-ticks mapping is identical on replay even if dt itself varies tick to tick (variable-rate
  // ticking), since each tick recomputes its own ticksFor(cooldownMs) from that tick's own dt.
  runtime._interactCooldownTicks = function(cooldownMs) {
    const dt = this.deltaTime > 0 ? this.deltaTime : (1 / 64)
    return Math.max(1, Math.round((cooldownMs / 1000) / dt))
  }

  runtime._tickInteractables = function() {
    if (this._interactableIds.size === 0) return
    const tick = this.currentTick
    if ((++_interactPruneTick & 255) === 0 && this._interactCooldowns.size > 100) {
      for (const [k, v] of this._interactCooldowns) { if (tick - v > 2000) this._interactCooldowns.delete(k) }
    }
    const players = this.getPlayers()
    for (const id of this._interactableIds) {
      const e = this.entities.get(id); if (!e || !e._interactable) continue
      for (const p of players) {
        const pp = p.state?.position; if (!pp) continue
        const dx = pp[0]-e.position[0], dy = pp[1]-e.position[1], dz = pp[2]-e.position[2]
        const ir = e._interactRadius; if (dx*dx+dy*dy+dz*dz > ir*ir) continue
        const key = e.id + ':' + p.id
        const expiresAtTick = this._interactCooldowns.get(key) || -Infinity
        const cooldown = e._interactCooldown ?? 500
        if (p.lastInput?.interact && tick >= expiresAtTick) {
          this._interactCooldowns.set(key, tick + this._interactCooldownTicks(cooldown))
          this.fireEvent(e.id, 'onInteract', p)
          const bus = this._eventBus.scope ? this._eventBus : null
          if (bus) bus.emit(`interact.${e.id}`, { player: p, entity: e })
        }
      }
    }
  }

  // Fires watch.callback(playerId) once per tick for every player within radius of the watching
  // entity's position -- O(watches x players), reusing the SAME per-tick players array _tickInteractables
  // already computed rather than each registered app polling its own nearest-player scan.
  runtime._tickProximityWatches = function(players) {
    if (this._proximityWatches.size === 0) return
    for (const [entityId, watch] of this._proximityWatches) {
      const e = this.entities.get(entityId); if (!e) continue
      const ex = e.position[0], ey = e.position[1], ez = e.position[2]
      for (const p of players) {
        const pp = p.state?.position; if (!pp) continue
        const dx = pp[0]-ex, dy = pp[1]-ey, dz = pp[2]-ez
        if (dx*dx+dy*dy+dz*dz <= watch.radius2) {
          try { watch.callback(p.id) } catch (e2) { console.error(`[AppRuntime] proximityWatch(${entityId}):`, e2.message) }
        }
      }
    }
  }

  // ONE shared O(n^2/2) player-pair scan per tick for all registered player-contact watchers -- each pair
  // within a watch's radius fires callback(a.id, b.id) once. The player list is materialised once; every
  // watcher reuses it and the same pair distances are re-tested per watcher (watchers differ only in radius).
  runtime._tickPlayerContactWatches = function(players) {
    if (this._playerContactWatches.size === 0) return
    const arr = Array.isArray(players) ? players : [...players]
    const n = arr.length
    if (n < 2) return
    for (const watch of this._playerContactWatches.values()) {
      const r2 = watch.radius2
      for (let i = 0; i < n; i++) {
        const a = arr[i], ap = a.state?.position; if (!ap) continue
        for (let j = i + 1; j < n; j++) {
          const b = arr[j], bp = b.state?.position; if (!bp) continue
          const dx = bp[0]-ap[0], dy = bp[1]-ap[1], dz = bp[2]-ap[2]
          if (dx*dx+dy*dy+dz*dz <= r2) {
            try { watch.callback(a.id, b.id) } catch (e2) { console.error('[AppRuntime] playerContactWatch:', e2.message) }
          }
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
      const toRemove = []
      for (const id of this._playerIndex._entities.keys()) {
        if (!ids.has(id)) toRemove.push(id)
      }
      for (const id of toRemove) this._playerIndex.remove(id)
    }
  }

  const _nearbyIdSet = new Set()

  runtime.getNearbyPlayers = function(viewerPosition, radius, allPlayers) {
    if (!allPlayers || allPlayers.length === 0) return []
    if (this._playerIndex.size === 0) {
      const cx = viewerPosition[0], cy = viewerPosition[1], cz = viewerPosition[2]
      const r2 = radius * radius
      return allPlayers.filter(p => { const dx=p.position[0]-cx,dy=p.position[1]-cy,dz=p.position[2]-cz; return dx*dx+dy*dy+dz*dz<=r2 })
    }
    _nearbyIdSet.clear()
    const ids = this._playerIndex.nearby(viewerPosition, radius)
    for (let i = 0; i < ids.length; i++) _nearbyIdSet.add(ids[i])
    return allPlayers.filter(p => _nearbyIdSet.has(p.id))
  }
}
