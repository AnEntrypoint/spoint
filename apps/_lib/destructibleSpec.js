// Pure spec-validation and launch-impulse-pattern helpers for createDestructible (destructible.js) --
// split out because they carry no closure state and no dependency on appCtx/the engine, unlike every
// other function in destructible.js which closes over the per-instance pool/timer state.

function _isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }

export function validateDestructibleSpec(spec) {
  if (spec !== null && typeof spec !== 'object') throw new TypeError('[destructible] spec must be an object')
  const s = spec || {}
  if (s.health != null && (typeof s.health !== 'number' || !Number.isFinite(s.health) || s.health <= 0)) {
    throw new TypeError('[destructible] health must be a positive finite number')
  }
  if (s.impactThreshold != null && (typeof s.impactThreshold !== 'number' || !Number.isFinite(s.impactThreshold) || s.impactThreshold < 0)) {
    throw new TypeError('[destructible] impactThreshold must be a non-negative finite number')
  }
  if (s.impactRadius != null && (typeof s.impactRadius !== 'number' || !Number.isFinite(s.impactRadius) || s.impactRadius <= 0)) {
    throw new TypeError('[destructible] impactRadius must be a positive finite number')
  }
  if (s.debrisCount != null && (!Number.isInteger(s.debrisCount) || s.debrisCount < 1)) {
    throw new TypeError('[destructible] debrisCount must be a positive integer')
  }
  if (s.debrisLifetime != null && (typeof s.debrisLifetime !== 'number' || !Number.isFinite(s.debrisLifetime) || s.debrisLifetime < 0)) {
    throw new TypeError('[destructible] debrisLifetime must be a non-negative finite number (seconds); 0 = never despawn')
  }
  if (s.debrisSettleGrace != null && (typeof s.debrisSettleGrace !== 'number' || !Number.isFinite(s.debrisSettleGrace) || s.debrisSettleGrace < 0)) {
    throw new TypeError('[destructible] debrisSettleGrace must be a non-negative finite number (seconds)')
  }
  if (s.debrisFreezeAfter != null && (typeof s.debrisFreezeAfter !== 'number' || !Number.isFinite(s.debrisFreezeAfter) || s.debrisFreezeAfter < 0)) {
    throw new TypeError('[destructible] debrisFreezeAfter must be a non-negative finite number (seconds); 0 = disable force-freeze')
  }
  if (s.respawnDelay != null && (typeof s.respawnDelay !== 'number' || !Number.isFinite(s.respawnDelay) || s.respawnDelay < 0)) {
    throw new TypeError('[destructible] respawnDelay must be a non-negative finite number (seconds); 0 = never respawn')
  }
  if (s.debrisImpulsePattern != null && typeof s.debrisImpulsePattern !== 'function' && !['outward', 'outward-up', 'up'].includes(s.debrisImpulsePattern)) {
    throw new TypeError('[destructible] debrisImpulsePattern must be "outward", "outward-up", "up", or a function(i, n, rng) -> [x,y,z]')
  }
  if (s.debrisShape != null && !_isPlainObject(s.debrisShape)) throw new TypeError('[destructible] debrisShape must be a plain object')
  if (s.fracturedAsset != null && typeof s.fracturedAsset !== 'string') throw new TypeError('[destructible] fracturedAsset must be a string path to a scripts/fracture-glb.mjs-baked GLB')
  if (s.fracturedPieceCount != null && (!Number.isInteger(s.fracturedPieceCount) || s.fracturedPieceCount < 1)) {
    throw new TypeError('[destructible] fracturedPieceCount must be a positive integer (the number of baked pieces in fracturedAsset)')
  }
  if (s.fracturedAsset != null && s.fracturedPieceCount == null) {
    throw new TypeError('[destructible] fracturedPieceCount is required when fracturedAsset is set (read it from the baked <asset>.pieces.json sidecar\'s pieceCount field)')
  }
  if (s.onDestroyed != null && typeof s.onDestroyed !== 'function') throw new TypeError('[destructible] onDestroyed must be a function')
  if (s.onRespawn != null && typeof s.onRespawn !== 'function') throw new TypeError('[destructible] onRespawn must be a function')
}

// cosmetic launch-direction jitter only, not gameplay-critical -- plain Math.random() is fine here.
// Exported: destructible.js's own _spawnDebris also uses this for its per-piece scatter offset.
export function jitter(spread) { return (Math.random() * 2 - 1) * spread }

export function resolveDebrisImpulsePattern(pattern) {
  if (typeof pattern === 'function') return pattern
  if (pattern === 'up') {
    return () => [0, 6 + Math.random() * 3, 0]
  }
  if (pattern === 'outward') {
    return (i, n) => {
      const angle = (i / n) * Math.PI * 2 + jitter(0.3)
      const mag = 3 + Math.random() * 2
      return [Math.cos(angle) * mag, 0, Math.sin(angle) * mag]
    }
  }
  // 'outward-up' (default): radial spread around the object plus a strong upward component,
  // matching the prototype's "outward+up launch impulses on impact" behavior.
  return (i, n) => {
    const angle = (i / n) * Math.PI * 2 + jitter(0.4)
    const mag = 2.5 + Math.random() * 2.5
    return [Math.cos(angle) * mag, 5 + Math.random() * 4, Math.sin(angle) * mag]
  }
}
