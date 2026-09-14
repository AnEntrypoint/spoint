function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const v3 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  length: (a) => Math.hypot(a[0], a[1], a[2]),
  normalize: (a) => { const l = v3.length(a) || 1; return [a[0] / l, a[1] / l, a[2] / l] },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

function pointInHull(p, faces, eps = 1e-6) {
  for (const f of faces) if (v3.dot(p, f.normal) - f.constant > eps) return false
  return true
}

function hullAABB(faces) {
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (const f of faces) for (const p of f.poly) {
    for (let k = 0; k < 3; k++) { if (p[k] < min[k]) min[k] = p[k]; if (p[k] > max[k]) max[k] = p[k] }
  }
  return { min, max }
}

function scatterSeeds(faces, count, rng) {
  const { min, max } = hullAABB(faces)
  const seeds = []
  let attempts = 0
  const maxAttempts = count * 500
  while (seeds.length < count && attempts < maxAttempts) {
    attempts++
    const p = [
      min[0] + rng() * (max[0] - min[0]),
      min[1] + rng() * (max[1] - min[1]),
      min[2] + rng() * (max[2] - min[2])
    ]
    if (pointInHull(p, faces)) seeds.push(p)
  }
  if (seeds.length < 2) throw new Error(`[fracture-glb] rejection sampling only found ${seeds.length} interior seed point(s) after ${attempts} attempts -- source hull may be degenerate (near-zero volume)`)
  return seeds
}

const SCALE_EPS = { plane: 1e-6, dedupe2: 1e-8, weld2: 1e-6, gapBridge: 1e-3 }
function setScale(diagonal) {
  const d = Math.max(diagonal, 1e-6)
  SCALE_EPS.plane = d * 1e-6
  SCALE_EPS.dedupe2 = (d * 1e-4) ** 2
  SCALE_EPS.weld2 = (d * 1e-3) ** 2
  SCALE_EPS.gapBridge = d * 1e-3
}

function clipPolygon(poly, normal, d) {
  if (poly.length < 3) return []
  const raw = []
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i], prev = poly[(i - 1 + poly.length) % poly.length]
    const curSide = v3.dot(cur, normal) + d
    const prevSide = v3.dot(prev, normal) + d
    const curIn = curSide <= SCALE_EPS.plane
    const prevIn = prevSide <= SCALE_EPS.plane
    if (curIn !== prevIn) {
      const t = prevSide / (prevSide - curSide)
      raw.push(v3.lerp(prev, cur, t))
    }
    if (curIn) raw.push(cur)
  }
  const out = []
  for (const p of raw) {
    const last = out[out.length - 1]
    if (last) { const dx = p[0] - last[0], dy = p[1] - last[1], dz = p[2] - last[2]; if (dx * dx + dy * dy + dz * dz < SCALE_EPS.dedupe2) continue }
    out.push(p)
  }
  if (out.length > 1) {
    const first = out[0], last = out[out.length - 1]
    const dx = first[0] - last[0], dy = first[1] - last[1], dz = first[2] - last[2]
    if (dx * dx + dy * dy + dz * dz < SCALE_EPS.dedupe2) out.pop()
  }
  return out
}

function clipFaceSoup(faceSoup, normal, d) {
  const out = []
  for (const f of faceSoup) {
    const poly = clipPolygon(f.poly, normal, d)
    if (poly.length >= 3) out.push({ poly, normal: f.normal })
  }
  return out
}

function weldKey(p) {
  const grid = Math.sqrt(SCALE_EPS.weld2) * 0.1
  const inv = grid > 0 ? 1 / grid : 1e5
  return `${Math.round(p[0] * inv)}|${Math.round(p[1] * inv)}|${Math.round(p[2] * inv)}`
}

function buildCapFace(faceSoup, planeNormal, d) {
  const eps = SCALE_EPS.plane
  const vertsByKey = new Map()
  const adjacency = new Map()
  function addVert(p) {
    const k = weldKey(p)
    if (!vertsByKey.has(k)) vertsByKey.set(k, p)
    return k
  }
  function addEdge(ka, kb) {
    if (ka === kb) return
    if (!adjacency.has(ka)) adjacency.set(ka, new Set())
    if (!adjacency.has(kb)) adjacency.set(kb, new Set())
    adjacency.get(ka).add(kb)
    adjacency.get(kb).add(ka)
  }
  for (const f of faceSoup) {
    const poly = f.poly
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length]
      const da = v3.dot(a, planeNormal) + d, db = v3.dot(b, planeNormal) + d
      if (Math.abs(da) < eps && Math.abs(db) < eps) addEdge(addVert(a), addVert(b))
    }
  }
  if (!adjacency.size) return null

  function oddDegreeKeys() { return [...adjacency.entries()].filter(([, s]) => s.size % 2 === 1).map(([k]) => k) }
  let odd = oddDegreeKeys()
  let bridgeGuard = odd.length + 2
  while (odd.length > 0 && bridgeGuard-- > 0) {
    let bestI = -1, bestJ = -1, bestDist2 = Infinity
    for (let i = 0; i < odd.length; i++) {
      for (let j = i + 1; j < odd.length; j++) {
        const a = vertsByKey.get(odd[i]), b = vertsByKey.get(odd[j])
        const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2]
        const dist2 = dx * dx + dy * dy + dz * dz
        if (dist2 < bestDist2) { bestDist2 = dist2; bestI = i; bestJ = j }
      }
    }
    if (bestI < 0 || bestDist2 > SCALE_EPS.gapBridge * SCALE_EPS.gapBridge) break
    addEdge(odd[bestI], odd[bestJ])
    odd = oddDegreeKeys()
  }

  const startKey = adjacency.keys().next().value
  const visited = new Set([startKey])
  const loopKeys = [startKey]
  let prevKey = null, curKey = startKey
  let guard = adjacency.size + 4
  while (guard-- > 0) {
    const neighbors = [...adjacency.get(curKey)].filter((k) => k !== prevKey)
    const next = neighbors.find((k) => !visited.has(k)) ?? (neighbors.includes(startKey) ? startKey : null)
    if (next == null) break
    if (next === startKey) break
    visited.add(next); loopKeys.push(next)
    prevKey = curKey; curKey = next
  }
  if (loopKeys.length !== adjacency.size) {
    throw new Error(`[fracture-glb] cap loop did not close (${loopKeys.length}/${adjacency.size} vertices walked) -- unrepairable plane-clip degeneracy`)
  }
  if (loopKeys.length < 3) return null
  const loop = loopKeys.map((k) => vertsByKey.get(k))
  let nx = 0, ny = 0, nz = 0
  for (let k = 0; k < loop.length; k++) {
    const a = loop[k], b = loop[(k + 1) % loop.length]
    nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1])
  }
  const windingNormal = [nx, ny, nz]
  if (v3.dot(windingNormal, planeNormal) < 0) loop.reverse()
  return { poly: loop, normal: [...planeNormal] }
}

function fractureCell(sourceFaces, seeds, i) {
  let soup = sourceFaces.map((f) => ({ poly: f.poly.slice(), normal: f.normal }))
  const seed = seeds[i]
  for (let j = 0; j < seeds.length; j++) {
    if (j === i) continue
    const other = seeds[j]
    const mid = v3.scale(v3.add(seed, other), 0.5)
    const normal = v3.normalize(v3.sub(other, seed))
    const d = -v3.dot(mid, normal)
    const clipped = clipFaceSoup(soup, normal, d)
    if (!clipped.length) { soup = []; break }
    const cap = buildCapFace(clipped, normal, d)
    soup = cap ? [...clipped, cap] : clipped
  }
  return weldSoup(soup)
}

function weldSoup(soup) {
  const canonical = []
  function canonicalize(p) {
    for (const q of canonical) {
      const dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2]
      if (dx * dx + dy * dy + dz * dz < SCALE_EPS.weld2) return q
    }
    canonical.push(p)
    return p
  }
  const out = []
  for (const f of soup) {
    const poly = weldPolygon(f.poly).map(canonicalize)
    const clean = []
    for (const p of poly) { if (clean.length === 0 || clean[clean.length - 1] !== p) clean.push(p) }
    if (clean.length > 1 && clean[0] === clean[clean.length - 1]) clean.pop()
    if (clean.length >= 3) out.push({ poly: clean, normal: f.normal })
  }
  return out
}

function weldPolygon(poly) {
  const out = []
  for (const p of poly) {
    let dup = false
    for (const q of out) {
      const dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2]
      if (dx * dx + dy * dy + dz * dz < SCALE_EPS.weld2) { dup = true; break }
    }
    if (!dup) out.push(p)
  }
  if (out.length > 1) {
    const f = out[0], l = out[out.length - 1]
    const dx = f[0] - l[0], dy = f[1] - l[1], dz = f[2] - l[2]
    if (dx * dx + dy * dy + dz * dz < SCALE_EPS.weld2) out.pop()
  }
  return out
}

export { mulberry32, v3, pointInHull, hullAABB, scatterSeeds, SCALE_EPS, setScale, clipPolygon, clipFaceSoup, weldKey, buildCapFace, weldSoup, weldPolygon, fractureCell }
