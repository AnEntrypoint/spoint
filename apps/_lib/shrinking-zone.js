function _isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }

function _isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v) }

function _isVec3(v) { return Array.isArray(v) && v.length === 3 && v.every(_isFiniteNum) }

const VALID_PENALTIES = new Set(['damage', 'push', 'both'])

const RING_UNIT_DISC_RADIUS = 0.5

function _validatePhase(p, i) {
  if (!_isPlainObject(p)) throw new TypeError(`[shrinking-zone] phases[${i}] must be an object`)
  if (!_isFiniteNum(p.radius) || p.radius < 0) throw new TypeError(`[shrinking-zone] phases[${i}].radius must be a non-negative finite number`)
  if (p.holdSec != null && (!_isFiniteNum(p.holdSec) || p.holdSec < 0)) throw new TypeError(`[shrinking-zone] phases[${i}].holdSec must be a non-negative finite number`)
  if (p.shrinkSec != null && (!_isFiniteNum(p.shrinkSec) || p.shrinkSec < 0)) throw new TypeError(`[shrinking-zone] phases[${i}].shrinkSec must be a non-negative finite number`)
}

function _validateSpec(spec) {
  if (spec !== null && typeof spec !== 'object') throw new TypeError('[shrinking-zone] spec must be an object')
  const s = spec || {}
  if (s.center != null && !_isVec3(s.center)) throw new TypeError('[shrinking-zone] center must be a [x,y,z] finite-number array')
  if (s.curve != null && s.curve !== 'linear' && s.curve !== 'phases') throw new TypeError('[shrinking-zone] curve must be "linear" or "phases"')
  const curve = s.curve ?? 'linear'
  if (curve === 'linear') {
    if (s.startRadius != null && (!_isFiniteNum(s.startRadius) || s.startRadius <= 0)) throw new TypeError('[shrinking-zone] startRadius must be a positive finite number')
    if (s.endRadius != null && (!_isFiniteNum(s.endRadius) || s.endRadius < 0)) throw new TypeError('[shrinking-zone] endRadius must be a non-negative finite number')
    if (s.durationSec != null && (!_isFiniteNum(s.durationSec) || s.durationSec <= 0)) throw new TypeError('[shrinking-zone] durationSec must be a positive finite number')
    const start = s.startRadius ?? 100, end = s.endRadius ?? 5
    if (end > start) throw new TypeError('[shrinking-zone] endRadius must not exceed startRadius')
  } else {
    if (!Array.isArray(s.phases) || s.phases.length === 0) throw new TypeError('[shrinking-zone] phases must be a non-empty array when curve is "phases"')
    s.phases.forEach(_validatePhase)
  }
  if (s.startDelaySec != null && (!_isFiniteNum(s.startDelaySec) || s.startDelaySec < 0)) throw new TypeError('[shrinking-zone] startDelaySec must be a non-negative finite number')
  if (s.outsidePenalty != null && !VALID_PENALTIES.has(s.outsidePenalty)) throw new TypeError('[shrinking-zone] outsidePenalty must be "damage", "push", or "both"')
  if (s.damagePerSec != null && (!_isFiniteNum(s.damagePerSec) || s.damagePerSec < 0)) throw new TypeError('[shrinking-zone] damagePerSec must be a non-negative finite number')
  if (s.pushForce != null && (!_isFiniteNum(s.pushForce) || s.pushForce < 0)) throw new TypeError('[shrinking-zone] pushForce must be a non-negative finite number')
  if (s.affectDynamicEntities != null && typeof s.affectDynamicEntities !== 'boolean') throw new TypeError('[shrinking-zone] affectDynamicEntities must be a boolean')
  if (s.showRing != null && typeof s.showRing !== 'boolean') throw new TypeError('[shrinking-zone] showRing must be a boolean')
  if (s.ringColor != null && (!Number.isInteger(s.ringColor) || s.ringColor < 0)) throw new TypeError('[shrinking-zone] ringColor must be a non-negative integer (hex color)')
  if (s.ringHeight != null && (!_isFiniteNum(s.ringHeight) || s.ringHeight <= 0)) throw new TypeError('[shrinking-zone] ringHeight must be a positive finite number')
  if (s.onPhaseChange != null && typeof s.onPhaseChange !== 'function') throw new TypeError('[shrinking-zone] onPhaseChange must be a function')
  if (s.onComplete != null && typeof s.onComplete !== 'function') throw new TypeError('[shrinking-zone] onComplete must be a function')
}

function _lerp(a, b, t) {
  const ct = t < 0 ? 0 : t > 1 ? 1 : t
  return a + (b - a) * ct
}

export function defineShrinkingZone(spec = {}, appCtx = null) {
  _validateSpec(spec)
  if (!appCtx) throw new TypeError('[shrinking-zone] appCtx is required')

  const center = spec.center ? [...spec.center] : [0, 0, 0]
  const curve = spec.curve ?? 'linear'
  const startDelaySec = spec.startDelaySec ?? 0
  const outsidePenalty = spec.outsidePenalty ?? 'damage'
  const damagePerSec = spec.damagePerSec ?? 5
  const pushForce = spec.pushForce ?? 8
  const affectDynamicEntities = !!spec.affectDynamicEntities
  const showRing = spec.showRing ?? true
  const ringColor = spec.ringColor ?? 0x00ffff
  const ringHeight = spec.ringHeight ?? 0.2

  const startRadius = spec.startRadius ?? 100
  const endRadius = spec.endRadius ?? 5
  const durationSec = spec.durationSec ?? 120

  const phases = curve === 'phases' ? spec.phases.map(p => ({ radius: p.radius, holdSec: p.holdSec ?? 0, shrinkSec: p.shrinkSec ?? 30 })) : null

  let _elapsed = 0
  let _radius = curve === 'phases' ? phases[0].radius : startRadius
  let _heldOrTargetPhaseIndex = 0
  let _completed = false
  let _ringId = null

  function _ringEntityId() { return `${appCtx.entity.id}_zone_ring` }

  function _spawnRing() {
    if (!showRing || _ringId) return
    const id = _ringEntityId()
    appCtx.world.spawnChild(id, {
      position: [center[0], center[1], center[2]],
      bodyType: 'static',
      app: 'shrinking-zone-ring',
      config: { r: _radius, h: ringHeight, color: ringColor }
    })
    _ringId = id
  }

  function _syncRing() {
    if (!showRing || !_ringId) return
    const e = appCtx.world.getEntity(_ringId)
    if (!e) return
    e.position[0] = center[0]; e.position[1] = center[1]; e.position[2] = center[2]
    const ringScale = _radius / RING_UNIT_DISC_RADIUS
    e.scale[0] = ringScale; e.scale[2] = ringScale
  }

  function _despawnRing() {
    if (!_ringId) return
    appCtx.world.destroy(_ringId)
    _ringId = null
  }

  function _computeLinearRadius(activeSec) {
    if (durationSec <= 0) return endRadius
    return _lerp(startRadius, endRadius, activeSec / durationSec)
  }

  function _computePhaseRadius(activeSec) {
    let acc = 0
    for (let i = 0; i < phases.length; i++) {
      const ph = phases[i]
      const holdEnd = acc + ph.holdSec
      const shrinkEnd = holdEnd + (i + 1 < phases.length ? phases[i + 1].shrinkSec : 0)
      if (activeSec < holdEnd) {
        if (i !== _heldOrTargetPhaseIndex) { _heldOrTargetPhaseIndex = i; if (typeof spec.onPhaseChange === 'function') spec.onPhaseChange(appCtx, zone) }
        return ph.radius
      }
      if (i + 1 < phases.length && activeSec < shrinkEnd) {
        if (i + 1 !== _heldOrTargetPhaseIndex) { _heldOrTargetPhaseIndex = i + 1; if (typeof spec.onPhaseChange === 'function') spec.onPhaseChange(appCtx, zone) }
        const t = (activeSec - holdEnd) / Math.max(1e-6, phases[i + 1].shrinkSec)
        return _lerp(ph.radius, phases[i + 1].radius, t)
      }
      acc = shrinkEnd
    }
    const last = phases.length - 1
    if (_heldOrTargetPhaseIndex !== last) { _heldOrTargetPhaseIndex = last; if (typeof spec.onPhaseChange === 'function') spec.onPhaseChange(appCtx, zone) }
    return phases[last].radius
  }

  function _isFinalRadiusReached() {
    return curve === 'linear' ? _radius <= endRadius : _radius <= phases[phases.length - 1].radius
  }

  let _outDirX = 0, _outDirZ = 0
  const _impulse = [0, 0, 0]
  function _penalizeTarget(pos, vel, dt, applyPush) {
    const dx = pos[0] - center[0], dz = pos[2] - center[2]
    const dist = Math.hypot(dx, dz)
    if (dist <= _radius) return false
    const dirX = dist > 1e-6 ? -dx / dist : 0, dirZ = dist > 1e-6 ? -dz / dist : 0
    if (applyPush && vel) { vel[0] += dirX * pushForce * dt; vel[2] += dirZ * pushForce * dt }
    _outDirX = dirX; _outDirZ = dirZ
    return true
  }

  function _scanPlayers(dt) {
    const applyDamage = outsidePenalty === 'damage' || outsidePenalty === 'both'
    const applyPush = outsidePenalty === 'push' || outsidePenalty === 'both'
    for (const player of appCtx.players.getAll()) {
      const st = player.state; if (!st || !st.position) continue
      if ((st.health ?? 1) <= 0) continue
      if (!_penalizeTarget(st.position, st.velocity, dt, applyPush)) continue
      if (applyDamage && damagePerSec > 0) {
        const before = st.health ?? 100
        st.health = Math.max(0, before - damagePerSec * dt)
        if (st.health <= 0 && before > 0) appCtx.players.send(player.id, { type: 'zone_death' })
      }
      if (applyPush && pushForce > 0) appCtx.players.send(player.id, { type: 'zone_push', dirX: _outDirX, dirZ: _outDirZ })
    }
  }

  function _scanDynamicEntities(dt) {
    if (!affectDynamicEntities) return
    const applyPush = outsidePenalty === 'push' || outsidePenalty === 'both'
    if (!applyPush) return
    const scanRadius = Math.max(_radius * 3, _radius + 200)
    const nearbyIds = appCtx.world.nearby(center, scanRadius)
    for (const id of nearbyIds) {
      if (id === appCtx.entity.id || id === _ringId) continue
      const e = appCtx.world.getEntity(id)
      if (!e || e.bodyType !== 'dynamic' || !e.position) continue
      if (!_penalizeTarget(e.position, null, dt, false)) continue
      if (pushForce > 0) {
        _impulse[0] = _outDirX * pushForce * dt; _impulse[2] = _outDirZ * pushForce * dt
        appCtx.world.applyImpulse(id, _impulse)
      }
    }
  }

  const zone = {
    get radius() { return _radius },
    get center() { return [...center] },
    get elapsed() { return _elapsed },
    get phaseIndex() { return _heldOrTargetPhaseIndex },
    get completed() { return _completed },
    get ringEntityId() { return _ringId },

    isOutside(pos) {
      if (!_isVec3(pos)) return false
      const dx = pos[0] - center[0], dz = pos[2] - center[2]
      return Math.hypot(dx, dz) > _radius
    },

    setCenter(pos) {
      if (!_isVec3(pos)) throw new TypeError('[shrinking-zone] setCenter requires a [x,y,z] finite-number array')
      center[0] = pos[0]; center[1] = pos[1]; center[2] = pos[2]
    },

    tick(dt) {
      if (!Number.isFinite(dt) || dt <= 0) return
      _elapsed += dt
      _spawnRing()
      const activeSec = _elapsed - startDelaySec
      if (activeSec > 0) {
        _radius = curve === 'linear' ? _computeLinearRadius(activeSec) : _computePhaseRadius(activeSec)
        if (!_completed && _isFinalRadiusReached()) {
          _completed = true
          if (typeof spec.onComplete === 'function') spec.onComplete(appCtx, zone)
        }
        _scanPlayers(dt)
        _scanDynamicEntities(dt)
      }
      _syncRing()
    },

    destroy() {
      _despawnRing()
    },

    reset() {
      _elapsed = 0
      _heldOrTargetPhaseIndex = 0
      _completed = false
      _radius = curve === 'phases' ? phases[0].radius : startRadius
    }
  }

  return zone
}

export default defineShrinkingZone
