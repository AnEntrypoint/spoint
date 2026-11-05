const DEFAULT_SAMPLES_PER_SEGMENT = 32
const UP = [0, 1, 0]
const SIDE_UP = [0, 0, 1]

function refusal(code, message) {
  const err = new TypeError(`[spline] ${message}`)
  err.reasonCode = code
  return err
}

function readId(id) {
  if (typeof id !== 'string' || id.length === 0) throw refusal('spline-id-invalid', `id must be a non-empty string, got ${JSON.stringify(id)}`)
  return id
}

function readPoint(point) {
  let x, y, z
  if (Array.isArray(point) && point.length === 3) {
    x = point[0]
    y = point[1]
    z = point[2]
  } else if (point !== null && typeof point === 'object' && !Array.isArray(point)) {
    x = point.x
    y = point.y
    z = point.z
  } else {
    throw refusal('spline-point-invalid', `point must be [x,y,z] or {x,y,z}, got ${JSON.stringify(point)}`)
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw refusal('spline-point-non-finite', `point coordinates must be finite, got ${JSON.stringify(point)}`)
  return [x, y, z]
}

function readOptions(options) {
  if (options === undefined) return { closed: false, tangentAxis: 'x', samplesPerSegment: DEFAULT_SAMPLES_PER_SEGMENT }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw refusal('spline-options-invalid', `options must be a plain object, got ${JSON.stringify(options)}`)
  const closed = options.closed === undefined ? false : options.closed
  const tangentAxis = options.tangentAxis === undefined ? 'x' : options.tangentAxis
  const samplesPerSegment = options.samplesPerSegment === undefined ? DEFAULT_SAMPLES_PER_SEGMENT : options.samplesPerSegment
  if (typeof closed !== 'boolean') throw refusal('spline-closed-invalid', `closed must be a boolean, got ${JSON.stringify(closed)}`)
  if (tangentAxis !== 'x' && tangentAxis !== 'z') throw refusal('spline-tangent-axis-invalid', `tangentAxis must be 'x' or 'z', got ${JSON.stringify(tangentAxis)}`)
  if (!Number.isInteger(samplesPerSegment) || samplesPerSegment < 4 || samplesPerSegment > 4096) throw refusal('spline-samples-invalid', `samplesPerSegment must be an integer in [4,4096], got ${JSON.stringify(samplesPerSegment)}`)
  return { closed, tangentAxis, samplesPerSegment }
}

function readT(t) {
  if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 1) throw refusal('spline-t-invalid', `t must be a finite number in [0,1], got ${JSON.stringify(t)}`)
  return t
}

function readDistance(distance, total) {
  if (typeof distance !== 'number' || !Number.isFinite(distance) || distance < 0 || distance > total) throw refusal('spline-distance-invalid', `distance must be a finite number in [0,${total}], got ${JSON.stringify(distance)}`)
  return distance
}

function readQuery(x, y, z) {
  if (![x, y, z].every((v) => typeof v === 'number' && Number.isFinite(v))) throw refusal('spline-query-non-finite', `query coordinates must be finite numbers, got ${JSON.stringify([x, y, z])}`)
  return [x, y, z]
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function scale(v, k) {
  return [v[0] * k, v[1] * k, v[2] * k]
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function dist2(a, b) {
  const d = sub(a, b)
  return dot(d, d)
}

function normalize(v, fallback) {
  const length = Math.hypot(v[0], v[1], v[2])
  if (!Number.isFinite(length) || length <= 1e-12) return fallback ? fallback.slice() : null
  return scale(v, 1 / length)
}

function controlAt(points, index, closed) {
  const n = points.length
  if (closed) return points[((index % n) + n) % n]
  if (index < 0) return sub(scale(points[0], 2), points[1])
  if (index >= n) return sub(scale(points[n - 1], 2), points[n - 2])
  return points[index]
}

function segmentIndex(segmentCount, u) {
  const clamped = Math.max(0, Math.min(segmentCount, u))
  const index = Math.min(Math.floor(clamped), segmentCount - 1)
  return { index, t: clamped - index }
}

function curve(p0, p1, p2, p3, t, derivative) {
  const t2 = t * t
  const out = [0, 0, 0]
  for (let a = 0; a < 3; a++) {
    const c1 = -p0[a] + p2[a]
    const c2 = 2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]
    const c3 = -p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]
    out[a] = derivative
      ? 0.5 * (c1 + 2 * c2 * t + 3 * c3 * t2)
      : 0.5 * (2 * p1[a] + c1 * t + c2 * t2 + c3 * t2 * t)
  }
  return out
}

function controls(spline, u) {
  const { index, t } = segmentIndex(spline.segments, u)
  return {
    t,
    p0: controlAt(spline.points, index - 1, spline.closed),
    p1: controlAt(spline.points, index, spline.closed),
    p2: controlAt(spline.points, index + 1, spline.closed),
    p3: controlAt(spline.points, index + 2, spline.closed),
  }
}

function positionAtU(spline, u) {
  const c = controls(spline, u)
  return curve(c.p0, c.p1, c.p2, c.p3, c.t, false)
}

function buildTable(points, closed, steps) {
  const segments = closed ? points.length : points.length - 1
  const spline = { points, closed, segments, steps }
  let previous = positionAtU(spline, 0)
  let distance = 0
  const samples = [{ u: 0, s: 0, point: previous }]
  for (let i = 0; i < segments; i++) {
    for (let j = 1; j <= steps; j++) {
      const u = i + j / steps
      const point = positionAtU(spline, u)
      distance += Math.hypot(point[0] - previous[0], point[1] - previous[1], point[2] - previous[2])
      samples.push({ u, s: distance, point })
      previous = point
    }
  }
  return { samples, total: distance, segments, steps }
}

function bracket(table, value, key) {
  const samples = table.samples
  let lo = 0
  let hi = samples.length - 1
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (samples[mid][key] <= value) lo = mid
    else hi = mid
  }
  return [samples[lo], samples[hi]]
}

function uAtDistance(table, distance) {
  const target = Math.max(0, Math.min(table.total, distance))
  const [a, b] = bracket(table, target, 's')
  const span = b.s - a.s
  return span > 0 ? a.u + (b.u - a.u) * (target - a.s) / span : a.u
}

function distanceAtU(table, u) {
  const target = Math.max(0, Math.min(table.segments, u))
  const [a, b] = bracket(table, target, 'u')
  const span = b.u - a.u
  return a.s + (b.s - a.s) * (span > 0 ? (target - a.u) / span : 0)
}

function quaternionFromBasis(x, y, z) {
  const m00 = x[0], m01 = y[0], m02 = z[0]
  const m10 = x[1], m11 = y[1], m12 = z[1]
  const m20 = x[2], m21 = y[2], m22 = z[2]
  const trace = m00 + m11 + m22
  if (trace > 0) {
    const s = 2 * Math.sqrt(trace + 1)
    return [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s]
  }
  if (m00 >= m11 && m00 >= m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22)
    return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]
  }
  if (m11 >= m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22)
    return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]
  }
  const s = 2 * Math.sqrt(1 + m22 - m00 - m11)
  return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]
}

function frame(spline, u) {
  const c = controls(spline, u)
  const position = curve(c.p0, c.p1, c.p2, c.p3, c.t, false)
  const tangent = normalize(curve(c.p0, c.p1, c.p2, c.p3, c.t, true), null)
    || normalize(sub(c.p2, c.p1), [1, 0, 0])
  const reference = Math.abs(dot(tangent, UP)) > 0.999 ? SIDE_UP : UP
  const normal = normalize(sub(reference, scale(tangent, dot(reference, tangent))), [1, 0, 0])
  const lateral = normalize(cross(tangent, normal), [0, 0, 1])
  const xAxis = spline.tangentAxis === 'z' ? scale(lateral, -1) : tangent
  const zAxis = spline.tangentAxis === 'z' ? tangent : lateral
  return { position, tangent, normal, lateral, rotation: quaternionFromBasis(xAxis, normal, zAxis) }
}

function closestOnTable(table, query) {
  const samples = table.samples
  let best = null
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i].point
    const b = samples[i + 1].point
    const ab = sub(b, a)
    const length2 = dot(ab, ab)
    const f = length2 > 0 ? Math.max(0, Math.min(1, dot(sub(query, a), ab) / length2)) : 0
    const point = [a[0] + ab[0] * f, a[1] + ab[1] * f, a[2] + ab[2] * f]
    const d2 = dist2(query, point)
    if (best === null || d2 < best.d2) best = { d2, u0: samples[i].u, u1: samples[i + 1].u, point }
  }
  return best
}

function refine(spline, query, u0, u1) {
  let lo = u0
  let hi = u1
  for (let i = 0; i < 24; i++) {
    const third = (hi - lo) / 3
    const a = lo + third
    const b = hi - third
    if (dist2(positionAtU(spline, a), query) < dist2(positionAtU(spline, b), query)) hi = b
    else lo = a
  }
  const u = (lo + hi) / 2
  const point = positionAtU(spline, u)
  return { u, point, d2: dist2(point, query) }
}

export function createSplineRegistry() {
  const splines = new Map()

  function requireSpline(id) {
    const key = readId(id)
    const spline = splines.get(key)
    if (!spline) throw refusal('spline-unknown-id', `unknown spline id ${JSON.stringify(key)}`)
    return spline
  }

  function describe(spline) {
    return {
      id: spline.id,
      closed: spline.closed,
      tangentAxis: spline.tangentAxis,
      points: spline.points.map((p) => p.slice()),
      length: spline.table.total,
      segments: spline.segments,
      samplesPerSegment: spline.steps,
    }
  }

  function add(id, points, options) {
    const key = readId(id)
    const opts = readOptions(options)
    const minPoints = opts.closed ? 3 : 2
    if (!Array.isArray(points) || points.length < minPoints) throw refusal('spline-too-few-points', `need >= ${minPoints} points for a ${opts.closed ? 'closed' : 'open'} spline, got ${Array.isArray(points) ? points.length : typeof points}`)
    const clean = points.map(readPoint)
    const table = buildTable(clean, opts.closed, opts.samplesPerSegment)
    if (!Number.isFinite(table.total) || table.total <= 0) throw refusal('spline-degenerate', `spline arc length must be finite and positive, got ${table.total}`)
    const spline = { id: key, points: clean, closed: opts.closed, tangentAxis: opts.tangentAxis, segments: table.segments, steps: opts.samplesPerSegment, table }
    splines.set(key, spline)
    return describe(spline)
  }

  function get(id) {
    return describe(requireSpline(id))
  }

  function sample(id, t) {
    const spline = requireSpline(id)
    const progress = readT(t)
    return frame(spline, uAtDistance(spline.table, progress * spline.table.total))
  }

  function length(id) {
    return requireSpline(id).table.total
  }

  function frameAt(id, distance) {
    const spline = requireSpline(id)
    const d = readDistance(distance, spline.table.total)
    return frame(spline, uAtDistance(spline.table, d))
  }

  function project(x, y, z) {
    const query = readQuery(x, y, z)
    if (splines.size === 0) throw refusal('spline-no-splines', 'no splines registered to project onto')
    let best = null
    for (const spline of splines.values()) {
      const coarse = closestOnTable(spline.table, query)
      const hit = refine(spline, query, coarse.u0, coarse.u1)
      if (best === null || hit.d2 < best.d2) {
        best = { id: spline.id, t: distanceAtU(spline.table, hit.u) / spline.table.total, point: hit.point, d2: hit.d2 }
      }
    }
    return { id: best.id, t: best.t, distance: Math.sqrt(best.d2), point: best.point }
  }

  function remove(id) {
    const key = readId(id)
    if (!splines.has(key)) throw refusal('spline-unknown-id', `unknown spline id ${JSON.stringify(key)}`)
    splines.delete(key)
    return true
  }

  return { add, get, sample, length, project, frameAt, remove }
}

export default createSplineRegistry
