function _clamp(v, max) {
  if (!Number.isFinite(max)) return v
  return v > max ? max : v < -max ? -max : v
}

export function createBuffStack(spec = {}, appCtx = null) {
  if (spec !== null && typeof spec !== 'object') throw new TypeError('[buffs] spec must be an object')
  const maxStack = Number.isFinite(spec.maxStack) ? spec.maxStack : Infinity
  const decayPerSec = Number.isFinite(spec.decayPerSec) ? spec.decayPerSec : 0
  const decayTarget = Number.isFinite(spec.decayTarget) ? spec.decayTarget : 1
  const _players = new Map()

  function _mapFor(playerId, create) {
    let m = _players.get(playerId)
    if (!m && create) { m = new Map(); _players.set(playerId, m) }
    return m
  }

  return {
    apply(playerId, buffKey, delta) {
      if (playerId == null || !buffKey) return 1
      const m = _mapFor(playerId, true)
      const cur = m.has(buffKey) ? m.get(buffKey) : 1
      const next = _clamp(cur + delta, maxStack)
      m.set(buffKey, next)
      return next
    },
    set(playerId, buffKey, value) {
      if (playerId == null || !buffKey) return 1
      const m = _mapFor(playerId, true)
      const next = _clamp(value, maxStack)
      m.set(buffKey, next)
      return next
    },
    get(playerId, buffKey) {
      const m = _mapFor(playerId, false)
      if (!m || !m.has(buffKey)) return 1
      return m.get(buffKey)
    },
    getAll(playerId) {
      const m = _mapFor(playerId, false)
      if (!m) return {}
      return Object.fromEntries(m)
    },
    clear(playerId, buffKey) {
      const m = _mapFor(playerId, false)
      if (!m) return
      if (buffKey) m.delete(buffKey); else m.clear()
    },
    clearAll() { _players.clear() },
    tick(dt) {
      if (decayPerSec <= 0) return
      const step = decayPerSec * dt
      for (const m of _players.values()) {
        for (const [k, v] of m) {
          if (v > decayTarget) m.set(k, Math.max(decayTarget, v - step))
          else if (v < decayTarget) m.set(k, Math.min(decayTarget, v + step))
        }
      }
    }
  }
}

export default createBuffStack
