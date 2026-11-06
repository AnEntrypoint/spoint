import { assertDefineSpecKeys } from './specBoundary.js'

function refusal(code, message) {
  const err = new TypeError(`[path] ${message}`)
  err.reasonCode = code
  return err
}

function readPoint(p) {
  if (Array.isArray(p) && p.length >= 2) {
    const x = p[0], y = p.length >= 3 ? p[1] : 0, z = p.length >= 3 ? p[2] : p[1]
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw refusal('path-point-invalid', `point must hold finite coordinates, got ${JSON.stringify(p)}`)
    return [x, y, z]
  }
  if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
    const x = p.x, y = p.y === undefined ? 0 : p.y, z = p.z
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw refusal('path-point-invalid', `point must hold finite coordinates, got ${JSON.stringify(p)}`)
    return [x, y, z]
  }
  throw refusal('path-point-invalid', `point must be [x,z], [x,y,z] or {x,y?,z}, got ${JSON.stringify(p)}`)
}

function readOptions(options) {
  if (options === undefined) return { closed: false, smooth: false, spacing: 0 }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw refusal('path-options-invalid', `options must be a plain object, got ${JSON.stringify(options)}`)
  assertDefineSpecKeys('definePathOptions', options)
  const closed = options.closed === undefined ? false : options.closed
  const smooth = options.smooth === undefined ? false : options.smooth
  const spacing = options.spacing === undefined ? 0 : options.spacing
  if (typeof closed !== 'boolean') throw refusal('path-closed-invalid', `closed must be a boolean, got ${JSON.stringify(closed)}`)
  if (typeof smooth !== 'boolean') throw refusal('path-smooth-invalid', `smooth must be a boolean, got ${JSON.stringify(smooth)}`)
  if (!Number.isFinite(spacing) || spacing < 0) throw refusal('path-spacing-invalid', `spacing must be a finite number >= 0, got ${spacing}`)
  return { closed, smooth, spacing }
}

function readWithin(within) {
  if (within === undefined || within === Infinity) return Infinity
  if (!Number.isFinite(within) || within < 0) throw refusal('path-within-invalid', `within must be a finite number >= 0, got ${within}`)
  return within
}

function readXZ(x, z) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) throw refusal('path-query-invalid', `x and z must be finite numbers, got ${x}, ${z}`)
}

export function definePath(points, options) {
  if (!Array.isArray(points) || points.length < 2) throw refusal('path-points-invalid', `need >= 2 points, got ${Array.isArray(points) ? points.length : typeof points}`)
  const { closed } = readOptions(options)
  const pts = points.map(readPoint)
  const n = pts.length
  const edgeCount = closed ? n : n - 1
  const edges = new Array(edgeCount)
  const segLens = new Array(edgeCount)
  const cumulativeDist = new Array(edgeCount + 1)
  cumulativeDist[0] = 0
  for (let i = 0; i < edgeCount; i++) {
    const a = pts[i], b = pts[(i + 1) % n]
    edges[i] = [a, b]
    const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    segLens[i] = d
    cumulativeDist[i + 1] = cumulativeDist[i] + d
  }
  const total = cumulativeDist[edgeCount]

  const segmentAt = (distance) => {
    const d = Math.max(0, Math.min(total, distance))
    for (let i = 0; i < edgeCount; i++) {
      if (d <= cumulativeDist[i + 1] || i === edgeCount - 1) {
        const segLen = segLens[i] || 1e-9
        return { index: i, t: Math.max(0, Math.min(1, (d - cumulativeDist[i]) / segLen)) }
      }
    }
    return { index: edgeCount - 1, t: 1 }
  }
  const pointAt = (distance) => {
    const { index, t } = segmentAt(distance)
    const a = edges[index][0], b = edges[index][1]
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
  }
  const directionAt = (distance) => {
    const { index } = segmentAt(distance)
    const a = edges[index][0], b = edges[index][1]
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2]
    const l = Math.hypot(dx, dy, dz) || 1
    return [dx / l, dy / l, dz / l]
  }
  const nearestIndex = (pos) => {
    let best = 0, bestD = Infinity
    for (let i = 0; i < n; i++) {
      const p = pts[i]
      const dx = p[0] - pos[0], dy = p[1] - pos[1], dz = p[2] - pos[2]
      const d = dx * dx + dy * dy + dz * dz
      if (d < bestD) { bestD = d; best = i }
    }
    return best
  }
  const progressAt = (pos) => {
    let bestD = Infinity, bestAlong = 0
    for (let i = 0; i < edgeCount; i++) {
      const a = edges[i][0], b = edges[i][1]
      const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2]
      const segLen2 = abx * abx + aby * aby + abz * abz || 1e-9
      let t = ((pos[0] - a[0]) * abx + (pos[1] - a[1]) * aby + (pos[2] - a[2]) * abz) / segLen2
      t = Math.max(0, Math.min(1, t))
      const cx = a[0] + abx * t, cy = a[1] + aby * t, cz = a[2] + abz * t
      const dx = pos[0] - cx, dy = pos[1] - cy, dz = pos[2] - cz
      const d = dx * dx + dy * dy + dz * dz
      if (d < bestD) { bestD = d; bestAlong = cumulativeDist[i] + Math.sqrt(segLen2) * t }
    }
    return total > 0 ? bestAlong / total : 0
  }

  const closest = (x, z) => {
    let best = null
    for (let i = 0; i < edgeCount; i++) {
      const a = edges[i][0], b = edges[i][1]
      const abx = b[0] - a[0], abz = b[2] - a[2]
      const segLen2 = abx * abx + abz * abz
      let t = segLen2 > 0 ? ((x - a[0]) * abx + (z - a[2]) * abz) / segLen2 : 0
      t = Math.max(0, Math.min(1, t))
      const px = a[0] + abx * t, pz = a[2] + abz * t
      const dx = x - px, dz = z - pz
      const d2 = dx * dx + dz * dz
      if (best === null || d2 < best.d2) {
        best = { index: i, t, point: [px, a[1] + (b[1] - a[1]) * t, pz], d2, distance: Math.sqrt(d2) }
      }
    }
    return best
  }
  const distance = (x, z, within) => {
    readXZ(x, z)
    const w = readWithin(within)
    const c = closest(x, z)
    return c.distance > w ? Infinity : c.distance
  }
  const nearest = (x, z, within) => {
    readXZ(x, z)
    const w = readWithin(within)
    const c = closest(x, z)
    if (c.distance > w) return null
    return { index: c.index, t: c.t, point: c.point, distance: c.distance }
  }
  const at = (index) => {
    if (!Number.isInteger(index)) throw refusal('path-index-invalid', `index must be an integer, got ${index}`)
    const i = closed ? ((index % n) + n) % n : Math.max(0, Math.min(n - 1, index))
    return pts[i].slice()
  }
  const onChartReanchor = ({ transfer }) => { for (const p of pts) transfer.point(p, p) }

  return {
    length: total, count: n, closed,
    pointAt, progressAt, nearestIndex, segmentAt, directionAt, onChartReanchor,
    distance, nearest, at,
  }
}

export default definePath
