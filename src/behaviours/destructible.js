import { validateDestructibleSpec, resolveDebrisImpulsePattern, jitter } from './destructibleSpec.js'

const _PARK_OFFSET = [0, -5000, 0]

export function createDestructible(spec = {}, appCtx = null) {
  validateDestructibleSpec(spec)
  if (!appCtx) throw new TypeError('[destructible] appCtx is required')

  const health = spec.health ?? 100
  const impactThreshold = spec.impactThreshold ?? 0
  const fracturedAsset = spec.fracturedAsset ?? null
  const debrisCount = fracturedAsset ? spec.fracturedPieceCount : (spec.debrisCount ?? 8)
  const debrisLifetime = spec.debrisLifetime ?? 8
  const debrisSettleGrace = spec.debrisSettleGrace ?? 0.5
  const debrisFreezeAfter = spec.debrisFreezeAfter ?? 3
  const respawnDelay = spec.respawnDelay ?? 0
  const impulseFn = resolveDebrisImpulsePattern(spec.debrisImpulsePattern ?? 'outward-up')

  const _homePosition = [...appCtx.entity.position]
  const _homeScale = [...(appCtx.entity.scale || [1, 1, 1])]
  const _homeCustom = appCtx.entity.custom ? { ...appCtx.entity.custom } : null

  let _damage = 0
  let _destroyed = false
  let _respawnTimer = 0
  const _debrisIds = new Set()
  const _poolFree = []
  const _poolAll = new Set()
  const _poolByKey = new Map()
  const _debrisTimers = new Map()
  const _lastSeenSpeed = new Map()

  function _intactHalfExtents() {
    const c = _homeCustom
    if (c && Number.isFinite(c.sx) && Number.isFinite(c.sy) && Number.isFinite(c.sz)) return [c.sx / 2, c.sy / 2, c.sz / 2]
    return [0.5, 0.5, 0.5]
  }

  const impactRadius = spec.impactRadius ?? (Math.max(..._intactHalfExtents()) * 1.5)

  function _pieceExtents() {
    const shape = spec.debrisShape
    if (shape && Number.isFinite(shape.hx) && Number.isFinite(shape.hy) && Number.isFinite(shape.hz)) return [shape.hx, shape.hy, shape.hz]
    const [hx, hy, hz] = _intactHalfExtents()
    const volumePreservingDivisor = Math.cbrt(debrisCount)
    return [hx / volumePreservingDivisor, hy / volumePreservingDivisor, hz / volumePreservingDivisor]
  }

  function _acquirePoolPiece(position, rotation, config, fixedSlotKey, model) {
    const spawnCfg = { position, rotation, bodyType: 'dynamic', app: 'destructible-debris', config }
    if (model) spawnCfg.model = model
    let id
    if (fixedSlotKey != null) {
      id = _poolByKey.get(fixedSlotKey)
      if (id == null) {
        id = `${appCtx.entity.id}_debris_${fixedSlotKey}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
        appCtx.world.spawnChild(id, spawnCfg)
        _poolByKey.set(fixedSlotKey, id)
        _poolAll.add(id)
        return id
      }
    } else {
      id = _poolFree.pop()
      if (id == null) {
        id = `${appCtx.entity.id}_debris_${_poolAll.size}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
        appCtx.world.spawnChild(id, spawnCfg)
        _poolAll.add(id)
        return id
      }
    }
    appCtx.world.setPosition(id, position, rotation)
    const e = appCtx.world.getEntity(id)
    if (e) e.scale = [1, 1, 1]
    return id
  }

  function _releasePoolPiece(id) {
    const e = appCtx.world.getEntity(id)
    if (e) { e.scale = [0, 0, 0]; appCtx.world.setPosition(id, [_PARK_OFFSET[0], _PARK_OFFSET[1], _PARK_OFFSET[2]]) }
    appCtx.world.setBodyActive(id, false)
    if (!fracturedAsset) _poolFree.push(id)
  }

  function _spawnFracturedDebris() {
    const shape = spec.debrisShape || {}
    const totalMass = shape.mass != null ? shape.mass : (_homeCustom?.mass ?? 50)
    const pieceMass = Math.max(0.1, totalMass / debrisCount)
    const color = shape.color ?? _homeCustom?.color ?? 0x8b4513
    const roughness = shape.roughness ?? _homeCustom?.roughness ?? 0.85
    const ids = []
    for (let i = 0; i < debrisCount; i++) {
      const id = _acquirePoolPiece(
        [..._homePosition],
        appCtx.entity.rotation,
        { fracturedAsset, pieceIndex: i, mass: pieceMass, color, roughness },
        i,
        fracturedAsset
      )
      appCtx.world.applyImpulse(id, impulseFn(i, debrisCount, Math.random))
      _debrisIds.add(id)
      _debrisTimers.set(id, { age: 0, remaining: debrisLifetime > 0 ? debrisLifetime : null, lod: 'physical' })
      ids.push(id)
    }
    return ids
  }

  function _spawnDebris() {
    if (fracturedAsset) return _spawnFracturedDebris()
    const [px, py, pz] = _homePosition
    const [hx, hy, hz] = _pieceExtents()
    const shape = spec.debrisShape || {}
    const totalMass = shape.mass != null ? shape.mass * debrisCount : (_homeCustom?.mass ?? 50)
    const pieceMass = Math.max(0.1, totalMass / debrisCount)
    const color = shape.color ?? _homeCustom?.color ?? 0x8b4513
    const roughness = shape.roughness ?? _homeCustom?.roughness ?? 0.85
    const ids = []
    for (let i = 0; i < debrisCount; i++) {
      const jx = jitter(hx * 0.5), jy = jitter(hy * 0.5), jz = jitter(hz * 0.5)
      const id = _acquirePoolPiece(
        [px + jx, py + jy, pz + jz],
        appCtx.entity.rotation,
        { hx, hy, hz, mass: pieceMass, color, roughness }
      )
      appCtx.world.applyImpulse(id, impulseFn(i, debrisCount, Math.random))
      _debrisIds.add(id)
      _debrisTimers.set(id, { age: 0, remaining: debrisLifetime > 0 ? debrisLifetime : null, lod: 'physical' })
      ids.push(id)
    }
    return ids
  }

  function _despawnAllDebris() {
    for (const id of _debrisIds) _releasePoolPiece(id)
    _debrisIds.clear()
    _debrisTimers.clear()
  }

  function drain() {
    for (const id of _poolAll) appCtx.world.destroy(id)
    _poolAll.clear(); _poolFree.length = 0; _poolByKey.clear()
    _debrisIds.clear(); _debrisTimers.clear()
  }

  function _scanForImpact() {
    const [ox, oy, oz] = appCtx.entity.position
    for (const p of appCtx.players.getAll()) {
      const pp = p.state?.position; if (!pp) continue
      const dx = pp[0] - ox, dy = pp[1] - oy, dz = pp[2] - oz
      if (dx * dx + dy * dy + dz * dz > impactRadius * impactRadius) continue
      const pv = p.state?.velocity
      if (!pv) continue
      if (destructible.impact(pv)) return
    }
    const nearbyIds = appCtx.world.nearby(appCtx.entity.position, impactRadius)
    for (const id of nearbyIds) {
      if (id === appCtx.entity.id || _debrisIds.has(id)) continue
      const e = appCtx.world.getEntity(id); if (!e || !e.velocity) continue
      if (destructible.impact(e.velocity)) return
    }
  }

  const destructible = {
    get destroyed() { return _destroyed },
    get damageTaken() { return _damage },
    get health() { return health },
    get debrisIds() { return [..._debrisIds] },
    get debrisPoolSize() { return _poolAll.size },
    get debrisPoolFree() { return _poolFree.length },

    get debrisLOD() { return [..._debrisTimers].map(([id, st]) => ({ id, age: st.age, remaining: st.remaining, lod: st.lod })) },

    damage(amount) {
      if (_destroyed || !(typeof amount === 'number' && Number.isFinite(amount)) || amount <= 0) return _destroyed
      _damage += amount
      if (_damage >= health) destructible.destroy()
      return _destroyed
    },

    impact(velocity) {
      if (_destroyed || impactThreshold <= 0 || !Array.isArray(velocity)) return _destroyed
      const speed = Math.hypot(velocity[0] || 0, velocity[1] || 0, velocity[2] || 0)
      if (speed < impactThreshold) return _destroyed
      return destructible.damage(health)
    },

    destroy() {
      if (_destroyed) return false
      _destroyed = true
      const ids = _spawnDebris()
      appCtx.entity.position = [_homePosition[0] + _PARK_OFFSET[0], _homePosition[1] + _PARK_OFFSET[1], _homePosition[2] + _PARK_OFFSET[2]]
      appCtx.entity.scale = [0, 0, 0]
      _respawnTimer = respawnDelay > 0 ? respawnDelay : 0
      if (typeof spec.onDestroyed === 'function') spec.onDestroyed(appCtx, ids)
      return true
    },

    respawn() {
      if (!_destroyed) return false
      _despawnAllDebris()
      _destroyed = false
      _damage = 0
      _respawnTimer = 0
      appCtx.entity.position = [..._homePosition]
      appCtx.entity.scale = [..._homeScale]
      if (typeof spec.onRespawn === 'function') spec.onRespawn(appCtx)
      return true
    },

    reset() {
      _despawnAllDebris()
      _destroyed = false
      _damage = 0
      _respawnTimer = 0
      appCtx.entity.position = [..._homePosition]
      appCtx.entity.scale = [..._homeScale]
    },

    tick(dt) {
      if (_debrisTimers.size) {
        for (const [id, st] of _debrisTimers) {
          st.age += dt
          if (st.remaining != null) {
            st.remaining -= dt
            if (st.remaining <= 0) {
              _releasePoolPiece(id)
              _debrisIds.delete(id)
              _debrisTimers.delete(id)
              continue
            }
          }
          if (st.lod === 'physical' && st.age >= debrisSettleGrace) {
            const forceFreeze = debrisFreezeAfter > 0 && st.age >= debrisFreezeAfter
            if (forceFreeze || appCtx.world.isAtRest(id)) {
              if (appCtx.world.setMotionType(id, 'kinematic')) st.lod = 'frozen'
            }
          }
          else if (st.lod === 'frozen') {
            if (appCtx.world.setMotionType(id, 'static')) st.lod = 'static'
          }
        }
      }
      if (_destroyed) {
        if (respawnDelay > 0) {
          _respawnTimer -= dt
          if (_respawnTimer <= 0) destructible.respawn()
        }
        return
      }
      if (impactThreshold > 0) _scanForImpact()
    },

    drain
  }

  return destructible
}

export default createDestructible
