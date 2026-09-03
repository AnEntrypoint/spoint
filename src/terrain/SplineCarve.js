const CELL_M = 8
const BIG = 1 << 23
const OFF = BIG >> 1

function cellKey(cx, cz) {
  return (cx + OFF) * BIG + (cz + OFF)
}

function carveHash(seed, i) {
  let h = seed | 0
  h = Math.imul(h ^ (i | 0), 0x27d4eb2d) >>> 0
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39) >>> 0
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

function catmullRom(p0, p1, p2, p3, t) {
  const getX = (p) => Array.isArray(p) ? p[0] : p.x
  const getZ = (p) => Array.isArray(p) ? p[1] : p.z

  const t2 = t * t
  const t3 = t2 * t

  const x = 0.5 * (
    (2 * getX(p1)) +
    (-getX(p0) + getX(p2)) * t +
    (2 * getX(p0) - 5 * getX(p1) + 4 * getX(p2) - getX(p3)) * t2 +
    (-getX(p0) + 3 * getX(p1) - 3 * getX(p2) + getX(p3)) * t3
  )
  const z = 0.5 * (
    (2 * getZ(p1)) +
    (-getZ(p0) + getZ(p2)) * t +
    (2 * getZ(p0) - 5 * getZ(p1) + 4 * getZ(p2) - getZ(p3)) * t2 +
    (-getZ(p0) + 3 * getZ(p1) - 3 * getZ(p2) + getZ(p3)) * t3
  )

  return { x, z }
}

export function sampleSpline(controlPoints, stepSize, closed = false) {
  if (!controlPoints || controlPoints.length < 2) return []
  const pts = controlPoints
  const n = closed ? pts.length : pts.length - 1
  const samples = []

  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + pts.length) % pts.length]
    const p1 = pts[i]
    const p2 = pts[(i + 1) % pts.length]
    const p3 = pts[(i + 2) % pts.length]

    const getX = (p) => Array.isArray(p) ? p[0] : p.x
    const getZ = (p) => Array.isArray(p) ? p[1] : p.z
    const dx = getX(p2) - getX(p1)
    const dz = getZ(p2) - getZ(p1)
    const segLen = Math.sqrt(dx * dx + dz * dz)
    const steps = Math.max(1, Math.ceil(segLen / stepSize))

    for (let s = 0; s < steps; s++) {
      const t = s / steps
      samples.push(catmullRom(p0, p1, p2, p3, t))
    }
  }

  if (!closed) {
    const last = pts[pts.length - 1]
    samples.push({ x: Array.isArray(last) ? last[0] : last.x, z: Array.isArray(last) ? last[1] : last.z })
  }

  return samples
}

export function carveSpline(heights, width, spacing, cornerX, cornerZ, controlPoints, carveWidth, carveDepth, opts = {}) {
  if (!heights || width < 2 || !Number.isFinite(spacing) || spacing <= 0) return { heights, carvedCells: new Set() }
  if (!controlPoints || controlPoints.length < 2) return { heights, carvedCells: new Set() }
  if (!Number.isFinite(carveWidth) || carveWidth <= 0 || !Number.isFinite(carveDepth)) return { heights, carvedCells: new Set() }

  const { bankWidth = 0, flag = 'river' } = opts
  const n = width
  const out = new Float32Array(heights)
  const carvedCells = new Set()

  const sampleStep = spacing * 0.5
  const splinePoints = sampleSpline(controlPoints, sampleStep)

  if (splinePoints.length === 0) return { heights: out, carvedCells }

  const halfWidth = carveWidth / 2
  const totalHalfWidth = halfWidth + bankWidth

  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const wx = cornerX + ix * spacing
      const wz = cornerZ + iz * spacing

      let minDist = Infinity
      for (const sp of splinePoints) {
        const dx = wx - sp.x
        const dz = wz - sp.z
        const dist = Math.sqrt(dx * dx + dz * dz)
        if (dist < minDist) minDist = dist
        if (minDist <= totalHalfWidth) break
      }

      if (minDist > totalHalfWidth) continue

      const idx = iz * n + ix
      if (!Number.isFinite(out[idx])) continue

      let falloff = 1
      if (minDist > halfWidth && bankWidth > 0) {
        falloff = 0.5 * (1 + Math.cos(((minDist - halfWidth) / bankWidth) * Math.PI))
      } else if (minDist > halfWidth) {
        continue
      }

      out[idx] -= carveDepth * falloff

      const cx = Math.floor(wx / CELL_M)
      const cz = Math.floor(wz / CELL_M)
      carvedCells.add(cellKey(cx, cz))
    }
  }

  return { heights: out, carvedCells, flag }
}

export function isCarved(carvedCells, cx, cz) {
  return carvedCells && carvedCells.has(cellKey(cx, cz))
}

export function createCarvedClimateFilter(carvedCells) {
  if (!carvedCells || carvedCells.size === 0) return null
  return function carvedClimateFilter(climate, cx, cz) {
    if (!climate) return null
    if (carvedCells.has(cellKey(cx, cz))) return null
    return climate
  }
}

export function createSplineCarveLayer() {
  const cells = new Map()
  const appliedSplines = []

  function carve(controlPoints, width, depth, kind, baseHeightFn, opts = {}) {
    if (!Array.isArray(controlPoints) || controlPoints.length < 2) return { touched: 0 }
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(depth)) return { touched: 0 }
    if (kind !== 'river' && kind !== 'road') return { touched: 0 }
    const { seed = 0, widthVariance = 0, bankErosion = 0 } = opts
    const isRiver = kind === 'river'
    const stepSize = Math.max(1, width * 0.5)
    const spinePoints = sampleSpline(controlPoints, stepSize)
    if (spinePoints.length === 0) return { touched: 0 }
    const maxHalfWidth = (width * 0.5) * (1 + (isRiver ? widthVariance : 0)) + (isRiver ? bankErosion : 0)
    let touched = 0
    let arcLen = 0
    for (let si = 0; si < spinePoints.length; si++) {
      const sp = spinePoints[si]
      const sx = sp.x, sz = sp.z
      if (si > 0) { const px = spinePoints[si - 1].x, pz = spinePoints[si - 1].z; arcLen += Math.hypot(sx - px, sz - pz) }
      let halfWidth = width * 0.5
      if (isRiver && widthVariance > 0) {
        const t = carveHash(seed, Math.round(arcLen * 0.1))
        halfWidth *= 1 + (t * 2 - 1) * widthVariance
      }
      const cx0 = Math.floor((sx - maxHalfWidth) / CELL_M), cx1 = Math.ceil((sx + maxHalfWidth) / CELL_M)
      const cz0 = Math.floor((sz - maxHalfWidth) / CELL_M), cz1 = Math.ceil((sz + maxHalfWidth) / CELL_M)
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const cMinX = cx * CELL_M, cMinZ = cz * CELL_M
          const ccx = cMinX + CELL_M * 0.5, ccz = cMinZ + CELL_M * 0.5
          let bankOffset = 0
          if (isRiver && bankErosion > 0) {
            const angle = carveHash(seed ^ 0x5bd1e995, cx * 92821 + cz) * Math.PI * 2
            bankOffset = (carveHash(seed ^ 0x1b873593, cx * 15485863 + cz) * 2 - 1) * bankErosion * (0.5 + 0.5 * Math.cos(angle))
          }
          const cellHalfWidth = halfWidth + bankOffset
          if (cellHalfWidth <= 0) continue
          const nearestX = Math.max(cMinX, Math.min(sx, cMinX + CELL_M))
          const nearestZ = Math.max(cMinZ, Math.min(sz, cMinZ + CELL_M))
          const d = Math.hypot(nearestX - sx, nearestZ - sz)
          if (d > cellHalfWidth) continue
          const dCenter = Math.hypot(ccx - sx, ccz - sz)
          const falloffDist = Math.min(dCenter, cellHalfWidth)
          const falloff = 0.5 * (1 + Math.cos((falloffDist / cellHalfWidth) * Math.PI))
          const key = cellKey(cx, cz)
          const base = typeof baseHeightFn === 'function' ? baseHeightFn(ccx, ccz) : null
          const targetDelta = Number.isFinite(base) ? -depth * falloff : 0
          const prev = cells.get(key)
          const nextDelta = prev ? Math.min(prev.delta, targetDelta) : targetDelta
          const nextKind = prev && prev.kind === 'river' ? 'river' : kind
          cells.set(key, { delta: nextDelta, kind: nextKind })
          touched++
        }
      }
    }
    if (touched > 0) appliedSplines.push({ controlPoints: controlPoints.map(p => Array.isArray(p) ? [p[0], p[1]] : [p.x, p.z]), width, depth, kind, seed, widthVariance, bankErosion })
    return { touched }
  }

  function deltaAt(x, z) {
    if (cells.size === 0) return 0
    const cx = Math.floor(x / CELL_M), cz = Math.floor(z / CELL_M)
    const c = cells.get(cellKey(cx, cz))
    return c ? c.delta : 0
  }

  function kindAt(x, z) {
    if (cells.size === 0) return null
    const cx = Math.floor(x / CELL_M), cz = Math.floor(z / CELL_M)
    const c = cells.get(cellKey(cx, cz))
    return c ? c.kind : null
  }

  function wrapHeightFn(baseHeightFn) {
    if (typeof baseHeightFn !== 'function') return baseHeightFn
    return function splineCarveWrappedHeightFn(x, z) {
      const base = baseHeightFn(x, z)
      if (!Number.isFinite(base)) return base
      return base + deltaAt(x, z)
    }
  }

  function wrapClimateField(baseField) {
    if (!baseField || typeof baseField.climateAtLocal !== 'function') return baseField
    return {
      ...baseField,
      climateAtLocal(x, z) {
        const base = baseField.climateAtLocal(x, z)
        const kind = kindAt(x, z)
        if (!kind) return base
        return base ? { ...base, blocked: kind } : { blocked: kind }
      },
    }
  }

  function toJSON() { return { version: 1, cellM: CELL_M, splines: appliedSplines.slice() } }

  function clear() { cells.clear(); appliedSplines.length = 0 }

  return {
    carve, deltaAt, kindAt, wrapHeightFn, wrapClimateField, toJSON, clear,
    get cellCount() { return cells.size }, get splineCount() { return appliedSplines.length },
  }
}

export function loadSplineCarveLayer(json, baseHeightFn) {
  const layer = createSplineCarveLayer()
  if (json && Array.isArray(json.splines)) {
    for (const s of json.splines) {
      if (!s || !Array.isArray(s.controlPoints) || !Number.isFinite(s.width) || !Number.isFinite(s.depth)) continue
      layer.carve(s.controlPoints, s.width, s.depth, s.kind, baseHeightFn, { seed: s.seed ?? 0, widthVariance: s.widthVariance ?? 0, bankErosion: s.bankErosion ?? 0 })
    }
  }
  return layer
}
