import { defineComponentSchema, registerComponentSchema } from './ComponentSchema.js'
import { createComponentPool } from './ComponentPool.js'

export const HEALTH_SCHEMA = defineComponentSchema({
  hp: { type: 'u16', tier: 'full' },
  max: { type: 'u16', tier: 'full' },
  alive: { type: 'bool', tier: 'full' },
})
registerComponentSchema('health', HEALTH_SCHEMA)

const _pool = createComponentPool({ fields: { hp: 'f32', max: 'f32', alive: 'f32', lastHitAt: 'f64', invulnMs: 'f64' } })
let _hp = _pool.column('hp'), _max = _pool.column('max'), _alive = _pool.column('alive')
let _lastHitAt = _pool.column('lastHitAt'), _invulnMs = _pool.column('invulnMs')
let _epoch = _pool.epoch
function _refreshColumnsIfPoolGrew() {
  if (_epoch === _pool.epoch) return
  _hp = _pool.column('hp'); _max = _pool.column('max'); _alive = _pool.column('alive')
  _lastHitAt = _pool.column('lastHitAt'); _invulnMs = _pool.column('invulnMs')
  _epoch = _pool.epoch
}

function _damageImpl(slot, spec, appCtx, amount, source) {
  _refreshColumnsIfPoolGrew()
  if (_alive[slot] !== 1) return _hp[slot]
  if (!(typeof amount === 'number' && Number.isFinite(amount)) || amount <= 0) return _hp[slot]
  const now = Date.now()
  const invulnMs = _invulnMs[slot]
  const withinIFrames = invulnMs > 0 && now - _lastHitAt[slot] < invulnMs
  if (withinIFrames) return _hp[slot]
  _lastHitAt[slot] = now
  const newHp = Math.max(0, _hp[slot] - amount)
  _hp[slot] = newHp
  if (newHp <= 0) {
    _alive[slot] = 0
    if (typeof spec.onDeath === 'function') spec.onDeath(appCtx, { source })
  } else if (typeof spec.onDamage === 'function') {
    spec.onDamage(appCtx, { amount, hp: newHp, max: _max[slot], source })
  }
  _refreshColumnsIfPoolGrew()
  return _hp[slot]
}

function _healImpl(slot, amount) {
  _refreshColumnsIfPoolGrew()
  if (_alive[slot] !== 1) return _hp[slot]
  if (!(typeof amount === 'number' && Number.isFinite(amount)) || amount <= 0) return _hp[slot]
  const newHp = Math.min(_max[slot], _hp[slot] + amount)
  _hp[slot] = newHp
  return newHp
}

function _killImpl(slot, spec, appCtx, source) {
  _refreshColumnsIfPoolGrew()
  if (_alive[slot] !== 1) return
  _hp[slot] = 0; _alive[slot] = 0
  if (typeof spec.onDeath === 'function') spec.onDeath(appCtx, { source })
}

function _respawnImpl(slot, spec, appCtx, hp) {
  _refreshColumnsIfPoolGrew()
  const max = _max[slot]
  const newHp = (typeof hp === 'number' && Number.isFinite(hp)) ? Math.max(0, Math.min(max, hp)) : max
  _hp[slot] = newHp
  const alive = newHp > 0
  _alive[slot] = alive ? 1 : 0
  _lastHitAt[slot] = -Infinity
  if (alive && typeof spec.onRespawn === 'function') spec.onRespawn(appCtx)
  _refreshColumnsIfPoolGrew()
  return _hp[slot]
}

function _setMaxImpl(slot, m) {
  _refreshColumnsIfPoolGrew()
  if (typeof m === 'number' && Number.isFinite(m) && m > 0) {
    _max[slot] = m
    if (_hp[slot] > m) _hp[slot] = m
  }
  return _max[slot]
}

export function defineHealth(spec = {}, appCtx) {
  if (!appCtx) throw new TypeError('[health] appCtx is required')
  if (typeof spec.max !== 'number' || !Number.isFinite(spec.max) || spec.max <= 0) {
    throw new TypeError('[health] max must be a positive finite number')
  }
  if (spec.invulnMs != null && (typeof spec.invulnMs !== 'number' || !Number.isFinite(spec.invulnMs) || spec.invulnMs < 0)) {
    throw new TypeError('[health] invulnMs must be a non-negative finite number')
  }

  const slot = _pool.alloc()
  _refreshColumnsIfPoolGrew()
  const startHp = (typeof spec.hp === 'number' && Number.isFinite(spec.hp)) ? Math.max(0, Math.min(spec.max, spec.hp)) : spec.max
  _hp[slot] = startHp
  _max[slot] = spec.max
  _alive[slot] = startHp > 0 ? 1 : 0
  _lastHitAt[slot] = -Infinity
  _invulnMs[slot] = spec.invulnMs ?? 0
  let _disposed = false

  const health = {
    get hp() { _refreshColumnsIfPoolGrew(); return _hp[slot] },
    get max() { _refreshColumnsIfPoolGrew(); return _max[slot] },
    get alive() { _refreshColumnsIfPoolGrew(); return _alive[slot] === 1 },
    get fraction() { _refreshColumnsIfPoolGrew(); const max = _max[slot]; return max > 0 ? _hp[slot] / max : 0 },
    damage(amount, source = null) { return _damageImpl(slot, spec, appCtx, amount, source) },
    heal(amount) { return _healImpl(slot, amount) },
    kill(source = null) { return _killImpl(slot, spec, appCtx, source) },
    respawn(hp) { return _respawnImpl(slot, spec, appCtx, hp) },
    setMax(m) { return _setMaxImpl(slot, m) },
  }
  if (typeof appCtx._registerDisposer === 'function') {
    appCtx._registerDisposer(() => { if (_disposed) return; _disposed = true; _pool.free(slot) })
  }
  return health
}

export default defineHealth
