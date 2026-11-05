export class ScatterSpecError extends Error {
  constructor(reasonCode, detail) {
    super(`[scatter-spec] ${reasonCode}: ${detail}`)
    this.name = 'ScatterSpecError'
    this.reasonCode = reasonCode
  }
}

const SAMPLING = Object.freeze(['uniform', 'grid'])
const OVERRIDE_KEYS = Object.freeze(['scale', 'yaw', 'model'])
const SALT_X = 0x9e3779b1
const SALT_Z = 0x85ebca6b
const SALT_SCALE = 0xc2b2ae35
const SALT_YAW = 0x27d4eb2f

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v)
const isCount = (v) => Number.isInteger(v) && v >= 0 && v <= 1e6

export function parseScatterSpec(spec) {
  if (spec === null || typeof spec !== 'object') throw new ScatterSpecError('not-object', 'spec must be an object')
  const { bounds, count, sampling = 'uniform', seed = 0, scale = { min: 1, max: 1 }, yaw = { min: 0, max: 0 }, model = '', overrides = [] } = spec
  if (bounds === null || typeof bounds !== 'object') throw new ScatterSpecError('bad-bounds', 'bounds must be an object')
  const { minX, maxX, minZ, maxZ } = bounds
  if (![minX, maxX, minZ, maxZ].every(isFiniteNumber) || minX > maxX || minZ > maxZ) {
    throw new ScatterSpecError('bad-bounds', 'bounds need finite minX<=maxX and minZ<=maxZ')
  }
  if (!isCount(count)) throw new ScatterSpecError('bad-count', 'count must be an integer in 0..1e6')
  if (!SAMPLING.includes(sampling)) throw new ScatterSpecError('bad-sampling', `sampling must be one of ${SAMPLING.join('|')}`)
  if (!Number.isInteger(seed)) throw new ScatterSpecError('bad-seed', 'seed must be an integer')
  for (const [name, range] of [['scale', scale], ['yaw', yaw]]) {
    if (range === null || typeof range !== 'object' || !isFiniteNumber(range.min) || !isFiniteNumber(range.max) || range.min > range.max) {
      throw new ScatterSpecError('bad-range', `${name} needs finite min<=max`)
    }
  }
  if (scale.min <= 0) throw new ScatterSpecError('bad-range', 'scale.min must be positive')
  if (typeof model !== 'string') throw new ScatterSpecError('bad-model', 'model must be a string')
  if (!Array.isArray(overrides)) throw new ScatterSpecError('bad-override', 'overrides must be an array')
  const byIndex = new Map()
  for (const o of overrides) {
    if (o === null || typeof o !== 'object' || !Number.isInteger(o.index) || o.index < 0 || o.index >= count) {
      throw new ScatterSpecError('bad-override', 'override.index must be an integer in 0..count-1')
    }
    if (byIndex.has(o.index)) throw new ScatterSpecError('bad-override', `duplicate override for index ${o.index}`)
    for (const key of Object.keys(o)) {
      if (key !== 'index' && !OVERRIDE_KEYS.includes(key)) throw new ScatterSpecError('bad-override', `unknown override key ${key}`)
    }
    if (o.scale !== undefined && (!isFiniteNumber(o.scale) || o.scale <= 0)) throw new ScatterSpecError('bad-override', 'override.scale must be positive')
    if (o.yaw !== undefined && !isFiniteNumber(o.yaw)) throw new ScatterSpecError('bad-override', 'override.yaw must be finite')
    if (o.model !== undefined && typeof o.model !== 'string') throw new ScatterSpecError('bad-override', 'override.model must be a string')
    byIndex.set(o.index, Object.freeze({ ...o }))
  }
  return Object.freeze({
    bounds: Object.freeze({ minX, maxX, minZ, maxZ }),
    count,
    sampling,
    seed,
    scale: Object.freeze({ min: scale.min, max: scale.max }),
    yaw: Object.freeze({ min: yaw.min, max: yaw.max }),
    model,
    overrides: byIndex,
  })
}

export function hashUnit(seed, salt, i) {
  let h = Math.imul(seed ^ Math.imul(i, 0x632be5ab) ^ salt, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

const lerp = (lo, hi, t) => lo + (hi - lo) * t

function pointAt(spec, i, cols, rows) {
  const { bounds, seed } = spec
  if (spec.sampling === 'grid') {
    const col = i % cols
    const row = Math.floor(i / cols)
    return [lerp(bounds.minX, bounds.maxX, (col + 0.5) / cols), lerp(bounds.minZ, bounds.maxZ, (row + 0.5) / rows)]
  }
  return [lerp(bounds.minX, bounds.maxX, hashUnit(seed, SALT_X, i)), lerp(bounds.minZ, bounds.maxZ, hashUnit(seed, SALT_Z, i))]
}

export function sampleScatter(spec) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(spec.count)))
  const rows = Math.max(1, Math.ceil(spec.count / cols))
  const out = []
  for (let i = 0; i < spec.count; i++) {
    const [x, z] = pointAt(spec, i, cols, rows)
    const base = {
      index: i,
      x,
      z,
      scale: lerp(spec.scale.min, spec.scale.max, hashUnit(spec.seed, SALT_SCALE, i)),
      yaw: lerp(spec.yaw.min, spec.yaw.max, hashUnit(spec.seed, SALT_YAW, i)),
      model: spec.model,
    }
    const o = spec.overrides.get(i)
    out.push(Object.freeze(o ? { ...base, ...o, index: i } : base))
  }
  return out
}
