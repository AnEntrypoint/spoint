export class TerrainMarkError extends Error {
  constructor(reasonCode, index, detail) {
    super(`[terrain-marks] mark ${index}: ${detail}`)
    this.name = 'TerrainMarkError'
    this.reasonCode = reasonCode
    this.index = index
  }
}


const smooth = (t) => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t)

function finiteAt(spec, index, key, { min = -Infinity, positive = false } = {}) {
  const v = spec[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TerrainMarkError('bad-number', index, `${key} must be a finite number`)
  if (v < min || (positive && !(v > 0))) throw new TerrainMarkError('bad-number', index, `${key} is out of range (${v})`)
  return v
}

function pointAt(spec, index, key) {
  const p = spec[key]
  if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new TerrainMarkError('bad-point', index, `${key} must be [x, z] of finite numbers`)
  return [p[0], p[1]]
}

function polylineAt(spec, index, key, withLevels) {
  const raw = spec[key]
  if (!Array.isArray(raw) || raw.length < 2) throw new TerrainMarkError('short-polyline', index, `${key} needs at least two points`)
  return raw.map((p, i) => {
    const xz = pointAt({ p: p.slice(0, 2) }, index, 'p')
    if (!withLevels) return { x: xz[0], z: xz[1] }
    const level = finiteAt(p.length === 3 ? { level: p[2] } : {}, index, 'level')
    return { x: xz[0], z: xz[1], level }
  })
}

function segmentDistance(x, z, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z
  const len2 = dx * dx + dz * dz
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2)) : 0
  const px = a.x + dx * t - x, pz = a.z + dz * t - z
  return { d: Math.hypot(px, pz), t }
}

function nearestOnPolyline(x, z, pts) {
  let best = { d: Infinity, t: 0, i: 0 }
  for (let i = 0; i + 1 < pts.length; i++) {
    const r = segmentDistance(x, z, pts[i], pts[i + 1])
    if (r.d < best.d) best = { d: r.d, t: r.t, i }
  }
  return best
}

function compileFlatten(spec, index) {
  const c = pointAt(spec, index, 'center')
  const radius = finiteAt(spec, index, 'radius', { positive: true })
  const falloff = finiteAt(spec, index, 'falloff', { min: 0 })
  const height = finiteAt(spec, index, 'height')
  return {
    apply(x, z, h) {
      const d = Math.hypot(x - c[0], z - c[1])
      const w = 1 - smooth((d - radius) / (falloff || 1e-9))
      return w <= 0 ? h : h + (height - h) * w
    },
    clears: () => false,
  }
}

function compilePond(spec, index) {
  const c = pointAt(spec, index, 'center')
  const radius = finiteAt(spec, index, 'radius', { positive: true })
  const falloff = finiteAt(spec, index, 'falloff', { min: 0 })
  const level = finiteAt(spec, index, 'level')
  return {
    apply(x, z, h) {
      const d = Math.hypot(x - c[0], z - c[1])
      const w = 1 - smooth((d - radius) / (falloff || 1e-9))
      if (w <= 0) return h
      const target = Math.min(h, level)
      return h + (target - h) * w
    },
    clears: () => false,
  }
}

function compileRiver(spec, index) {
  const pts = polylineAt(spec, index, 'points', false)
  const width = finiteAt(spec, index, 'width', { positive: true })
  const falloff = finiteAt(spec, index, 'falloff', { min: 0 })
  const depth = finiteAt(spec, index, 'depth', { min: 0 })
  const half = width / 2
  return {
    apply(x, z, h) {
      const { d } = nearestOnPolyline(x, z, pts)
      const w = 1 - smooth((d - half) / (falloff || 1e-9))
      return w <= 0 ? h : h - depth * w
    },
    clears: () => false,
  }
}

function compilePath(spec, index) {
  const pts = polylineAt(spec, index, 'points', true)
  const width = finiteAt(spec, index, 'width', { positive: true })
  const falloff = finiteAt(spec, index, 'falloff', { min: 0 })
  const half = width / 2
  return {
    apply(x, z, h) {
      const { d, i, t } = nearestOnPolyline(x, z, pts)
      const w = 1 - smooth((d - half) / (falloff || 1e-9))
      if (w <= 0) return h
      const level = pts[i].level + (pts[i + 1].level - pts[i].level) * t
      return h + (level - h) * w
    },
    clears: () => false,
  }
}

function compileClear(spec, index) {
  const c = pointAt(spec, index, 'center')
  const radius = finiteAt(spec, index, 'radius', { positive: true })
  const r2 = radius * radius
  return {
    apply: (x, z, h) => h,
    clears(x, z) {
      const dx = x - c[0], dz = z - c[1]
      return dx * dx + dz * dz <= r2
    },
  }
}

function compileGrade(spec, index) {
  const c = pointAt(spec, index, 'center')
  const radius = finiteAt(spec, index, 'radius', { positive: true })
  const falloff = finiteAt(spec, index, 'falloff', { min: 0 })
  const level = finiteAt(spec, index, 'level')
  const slope = finiteAt(spec, index, 'slope')
  const maxGrade = finiteAt(spec, index, 'maxGrade', { min: 0 })
  if (Math.abs(slope) > maxGrade) throw new TerrainMarkError('grade-too-steep', index, `slope ${slope} exceeds maxGrade ${maxGrade}`)
  return {
    apply(x, z, h) {
      const d = Math.hypot(x - c[0], z - c[1])
      const w = 1 - smooth((d - radius) / (falloff || 1e-9))
      if (w <= 0) return h
      const target = level + slope * (x - c[0])
      return h + (target - h) * w
    },
    clears: () => false,
  }
}

function compileSpline(spec, index) {
  const pts = polylineAt(spec, index, 'points', true)
  const width = finiteAt(spec, index, 'width', { min: 0 })
  const falloff = finiteAt(spec, index, 'falloff', { positive: true })
  const half = width / 2
  return {
    apply(x, z, h) {
      const { d, i, t } = nearestOnPolyline(x, z, pts)
      const w = 1 - smooth((d - half) / falloff)
      if (w <= 0) return h
      const level = pts[i].level + (pts[i + 1].level - pts[i].level) * t
      return h + (level - h) * w
    },
    clears: () => false,
  }
}

function compileLiquid(spec, index) {
  const c = pointAt(spec, index, 'center')
  const radius = finiteAt(spec, index, 'radius', { positive: true })
  const level = finiteAt(spec, index, 'level')
  return {
    apply: (x, z, h) => h,
    clears: () => false,
    levelAt(x, z) {
      return Math.hypot(x - c[0], z - c[1]) <= radius ? level : null
    },
  }
}

const COMPILERS = Object.freeze({ flatten: compileFlatten, pond: compilePond, lake: compilePond, sea: compilePond, river: compileRiver, path: compilePath, road: compilePath, clear: compileClear, hole: compileClear, grade: compileGrade, spline: compileSpline, liquid: compileLiquid })

export const TERRAIN_MARK_KINDS = Object.freeze(Object.keys(COMPILERS))

export function compileTerrainMarks(specs) {
  if (!Array.isArray(specs)) throw new TerrainMarkError('not-a-list', -1, 'marks must be an array')
  const compiled = specs.map((spec, index) => {
    if (spec === null || typeof spec !== 'object') throw new TerrainMarkError('not-an-object', index, 'a mark must be an object')
    const compile = COMPILERS[spec.kind]
    if (!compile || !Object.prototype.hasOwnProperty.call(COMPILERS, spec.kind)) throw new TerrainMarkError('unknown-kind', index, `kind ${JSON.stringify(spec.kind)} is not one of ${TERRAIN_MARK_KINDS.join(', ')}`)
    return compile(spec, index)
  })
  const heightMarks = compiled.filter((_, i) => specs[i].kind !== 'clear' && specs[i].kind !== 'hole')
  const clearsAt = (x, z) => {
    for (const m of compiled) if (m.clears(x, z)) return true
    return false
  }
  return Object.freeze({
    count: compiled.length,
    clearsAt,
    height(x, z, h) {
      if (clearsAt(x, z)) return h
      let out = h
      for (const m of heightMarks) out = m.apply(x, z, out)
      return out
    },
    liquidLevelAt(x, z) {
      for (const m of compiled) {
        const level = m.levelAt?.(x, z)
        if (level !== undefined && level !== null) return level
      }
      return null
    },
  })
}

export function wrapHeightWithMarks(specs, heightFn) {
  const marks = compileTerrainMarks(specs ?? [])
  if (marks.count === 0) return heightFn
  return (x, z, yGuess) => marks.height(x, z, heightFn(x, z, yGuess))
}
