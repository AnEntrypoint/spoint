const _isNode = typeof process !== 'undefined' && !!process.versions && !!process.versions.node
const _msFile = (p) => (_isNode ? `mapspinner/${p}` : `/node_modules/mapspinner/src/${p}`)

const { FACE_FRAME, worldToFaceLocal } = await import(_msFile('planet-orchestrator-cull.js'))

export const MESH_SURFACE_NO_GROUND = null
export function isMeshSurfaceNoGround(v) { return v === MESH_SURFACE_NO_GROUND }

const QUARTER_PI = Math.PI / 4
// The fixed point a direction's height is solved to, and the test that an answer is the surface's
// rather than the seed's: the same two numbers client/core/ExactPatchFrame.js uses for the mesh
// surface, so a vertex read from the lattice and a vertex read from the sampler cannot disagree
// about what "reached the ground" means.
const MESH_SOLVE_ITERS = 4
const MESH_SOLVE_TOL_M = 1e-6
const DEFAULT_FOCUS_RADIUS_M = 240
const DEFAULT_MAX_QUADS = 128
const FOOTPRINT_INFLATE_M = 1
const FOOTPRINT_BLOAT = 1.06
const REACH_MUL = 1.6
const QUAD_CORNER_U = [0, 1, 1, 0]
const QUAD_CORNER_V = [0, 0, 1, 1]

function refusal(key, why) {
  throw new TypeError(`createTerrainMeshSurface: opts.${key} ${why}`)
}

function deformDir(face, u, v, R, out) {
  const F = FACE_FRAME[face]
  if (!F) return false
  const wx = R * Math.tan((u / R) * QUARTER_PI)
  const wy = R * Math.tan((v / R) * QUARTER_PI)
  const ax = F.u[0] * wx + F.v[0] * wy + F.c[0] * R
  const ay = F.u[1] * wx + F.v[1] * wy + F.c[1] * R
  const az = F.u[2] * wx + F.v[2] * wy + F.c[2] * R
  const len = Math.sqrt(ax * ax + ay * ay + az * az)
  if (!(len > 0)) return false
  out[0] = ax / len; out[1] = ay / len; out[2] = az / len
  return true
}

function cellFlip(x, y) {
  let h = (x | (y << 16)) | 0
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b | 0)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b | 0)
  h = h ^ (h >>> 16)
  return (h >>> 17) & 1
}

export function createTerrainMeshSurface(opts = {}) {
  const frame = opts.frame
  if (!frame) refusal('frame', 'must be a planet frame')
  if (!Number.isFinite(frame.radius) || frame.radius <= 0) refusal('frame.radius', 'must be a finite positive radius')
  if (!Number.isFinite(frame.anchorHeight)) refusal('frame.anchorHeight', 'must be a finite number')
  if (!Number.isFinite(frame.offsetY)) refusal('frame.offsetY', 'must be a finite number')
  if (!Array.isArray(frame.up) || !Array.isArray(frame.east) || !Array.isArray(frame.north)) {
    refusal('frame.up/east/north', 'must be the chart basis arrays the placement chart writes its surface in')
  }
  if (typeof opts.heightAtDir !== 'function') refusal('heightAtDir', 'must be the height function the terrain mesh vertices sample')
  if (typeof opts.quads !== 'function') refusal('quads', 'must return the drawn quad payload, or null when nothing was drawn')
  const focusRadiusM = opts.focusRadiusM === undefined ? DEFAULT_FOCUS_RADIUS_M : opts.focusRadiusM
  if (!Number.isFinite(focusRadiusM) || focusRadiusM <= 0) refusal('focusRadiusM', 'must be a finite positive number of metres')
  const maxQuads = opts.maxQuads === undefined ? DEFAULT_MAX_QUADS : opts.maxQuads
  if (!Number.isFinite(maxQuads) || maxQuads < 1) refusal('maxQuads', 'must be a finite count of at least one')

  const R = frame.radius
  const base = R + frame.anchorHeight - frame.offsetY
  const U = frame.up, E = frame.east, N = frame.north
  const heightAtDir = opts.heightAtDir
  const quadsFn = opts.quads
  // The shared lattice: the sample buffer the collider builds its field from
  // (src/terrain/LatticeSurface.js). Where it covers a vertex it IS the ground, so the vertex reads
  // it instead of asking the sampler to solve the same point again -- one copy, not two answers.
  const lattice = (opts.lattice && typeof opts.lattice.covers === 'function' && typeof opts.lattice.heightAtLocal === 'function') ? opts.lattice : null

  // A direction is not a chart-local (x,z): the point along it sits at radial distance rho, and its
  // chart-local height is the height AT the (x,z) that same rho implies, so
  //   rho * du - base = H(rho * de, rho * dn)
  // is one fixed point in rho -- the same one client/core/ExactPatchFrame.js solves for the mesh
  // surface, so the two agree about what "the ground along this direction" means. Near the chart's
  // anchor it contracts in a step or two, because x and z move by the direction's own east/north
  // components. An answer that has NOT converged is a function of the seed and not of the surface,
  // so it is refused and the sampler answers instead: no vertex silently loses its ground.
  function latticeHeightAtDir(d) {
    const len = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2])
    if (!(len > 0)) return NaN
    const de = (d[0] * E[0] + d[1] * E[1] + d[2] * E[2]) / len
    const du = (d[0] * U[0] + d[1] * U[1] + d[2] * U[2]) / len
    const dn = (d[0] * N[0] + d[1] * N[1] + d[2] * N[2]) / len
    if (!(Math.abs(du) > 1e-9)) return NaN
    let rho = R + (Number.isFinite(frame.anchorHeight) ? frame.anchorHeight : 0)
    let converged = false
    for (let k = 0; k < MESH_SOLVE_ITERS; k++) {
      const x = rho * de, z = rho * dn
      if (!lattice.covers(x, z)) return NaN
      const y = lattice.heightAtLocal(x, z)
      if (!Number.isFinite(y)) return NaN
      const next = (y + base) / du
      if (!Number.isFinite(next)) return NaN
      const step = next - rho
      rho = next
      if (Math.abs(step) <= MESH_SOLVE_TOL_M) { converged = true; break }
    }
    return converged ? rho - R : NaN
  }

  const focus = [0, 0]
  const near = []
  const built = new Map()
  const candidates = []
  const stats = { syncs: 0, builds: 0, queries: 0, served: 0, unserved: 0, rescans: 0, nearQuads: 0, latticeVertexHits: 0, latticeVertexMisses: 0 }
  let gridSize = 0
  let flip = null
  let version = 0

  const _dir = [0, 0, 0]
  const _camW = [0, 0, 0]
  const _camFL = [null, null, null, null, null, null]

  function ensureGrid(g) {
    if (gridSize === g && flip) return
    gridSize = g
    const w = g + 2
    flip = new Uint8Array(w * w)
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) flip[y * w + x] = cellFlip(x, y)
    }
    built.clear()
  }

  function buildQuad(face, ox, oy, l) {
    const g = gridSize
    const n = g + 1
    const pos = new Float64Array(n * n * 3)
    for (let j = 0; j <= g; j++) {
      const v = oy + (j / g) * l
      for (let i = 0; i <= g; i++) {
        if (!deformDir(face, ox + (i / g) * l, v, R, _dir)) return null
        let h = NaN
        if (lattice) {
          h = latticeHeightAtDir(_dir)
          if (Number.isFinite(h)) stats.latticeVertexHits++
          else stats.latticeVertexMisses++
        }
        if (!Number.isFinite(h)) h = heightAtDir(_dir)
        if (!Number.isFinite(h)) return null
        const s = R + h
        const wx = _dir[0] * s, wy = _dir[1] * s, wz = _dir[2] * s
        const k = (j * n + i) * 3
        pos[k] = wx * E[0] + wy * E[1] + wz * E[2]
        pos[k + 1] = wx * U[0] + wy * U[1] + wz * U[2] - base
        pos[k + 2] = wx * N[0] + wy * N[1] + wz * N[2]
      }
    }
    const at = (i, j) => (j * n + i) * 3
    const x00 = pos[at(0, 0)], z00 = pos[at(0, 0) + 2]
    const x10 = pos[at(g, 0)], z10 = pos[at(g, 0) + 2]
    const x01 = pos[at(0, g)], z01 = pos[at(0, g) + 2]
    const x11 = pos[at(g, g)], z11 = pos[at(g, g) + 2]
    const dxdi = ((x10 - x00) + (x11 - x01)) / (2 * g)
    const dxdj = ((x01 - x00) + (x11 - x10)) / (2 * g)
    const dzdi = ((z10 - z00) + (z11 - z01)) / (2 * g)
    const dzdj = ((z01 - z00) + (z11 - z10)) / (2 * g)
    const det = dxdi * dzdj - dxdj * dzdi
    if (!(Math.abs(det) > 0)) return null
    return {
      face, ox, oy, l, pos,
      i11: dzdj / det, i12: -dxdj / det, i21: -dzdi / det, i22: dxdi / det,
      x0: x00, z0: z00,
    }
  }

  function quadKey(face, ox, oy, level) {
    return `${face}|${Math.round(ox * 1000)}|${Math.round(oy * 1000)}|${level}|${frame.chartEpoch}`
  }

  function materialize(entry) {
    const key = quadKey(entry.face, entry.ox, entry.oy, entry.level)
    const hit = built.get(key)
    if (hit) return hit
    const q = buildQuad(entry.face, entry.ox, entry.oy, entry.l)
    if (!q) return null
    stats.builds++
    built.set(key, q)
    if (built.size > maxQuads) built.delete(built.keys().next().value)
    return q
  }

  function triY(p, ia, ib, ic, x, z) {
    const ax = p[ia], az = p[ia + 2], ay = p[ia + 1]
    const bx = p[ib], bz = p[ib + 2], by = p[ib + 1]
    const cx = p[ic], cz = p[ic + 2], cy = p[ic + 1]
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
    if (det === 0) return null
    const wa = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det
    const wb = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det
    const wc = 1 - wa - wb
    if (wa < -1e-12 || wb < -1e-12 || wc < -1e-12) return null
    return wa * ay + wb * by + wc * cy
  }

  function cellY(q, i, j, x, z) {
    if (i < 0 || j < 0 || i >= gridSize || j >= gridSize) return null
    const n = gridSize + 1
    const a = (j * n + i) * 3, b = (j * n + i + 1) * 3
    const c = ((j + 1) * n + i) * 3, d = ((j + 1) * n + i + 1) * 3
    const p = q.pos
    return flip[(j + 1) * (gridSize + 2) + (i + 1)]
      ? (triY(p, a, c, d, x, z) ?? triY(p, a, d, b, x, z))
      : (triY(p, a, c, b, x, z) ?? triY(p, b, c, d, x, z))
  }

  function quadY(q, x, z) {
    const dx = x - q.x0, dz = z - q.z0
    const fi = q.i11 * dx + q.i12 * dz
    const fj = q.i21 * dx + q.i22 * dz
    const i0 = Math.floor(fi), j0 = Math.floor(fj)
    for (let j = j0 - 1; j <= j0 + 1; j++) {
      for (let i = i0 - 1; i <= i0 + 1; i++) {
        const y = cellY(q, i, j, x, z)
        if (y !== null) return y
      }
    }
    stats.rescans++
    for (let j = 0; j < gridSize; j++) {
      for (let i = 0; i < gridSize; i++) {
        const y = cellY(q, i, j, x, z)
        if (y !== null) return y
      }
    }
    return null
  }

  function setFocus(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return
    focus[0] = x; focus[1] = z
  }

  function sync() {
    version++
    stats.syncs++
    near.length = 0
    const q = quadsFn()
    if (!q || !q.offsets || !q.faces || !Number.isFinite(q.count) || q.count <= 0) { stats.nearQuads = 0; return }
    const g = q.gridSize | 0
    if (!(g >= 1)) { stats.nearQuads = 0; return }
    ensureGrid(g)
    _camW[0] = U[0] * (R + frame.anchorHeight) + E[0] * focus[0] + N[0] * focus[1]
    _camW[1] = U[1] * (R + frame.anchorHeight) + E[1] * focus[0] + N[1] * focus[1]
    _camW[2] = U[2] * (R + frame.anchorHeight) + E[2] * focus[0] + N[2] * focus[1]
    for (let face = 0; face < 6; face++) _camFL[face] = worldToFaceLocal(face, _camW, R)
    const reach = focusRadiusM * REACH_MUL
    const count = Math.min(q.count, (q.offsets.length / 4) | 0)
    for (let n = 0; n < count; n++) {
      const face = q.faces[n] | 0
      const ox = q.offsets[n * 4], oy = q.offsets[n * 4 + 1], l = q.offsets[n * 4 + 2], level = q.offsets[n * 4 + 3]
      if (!Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(l) || !(l > 0)) continue
      const cam = _camFL[face]
      if (!cam) continue
      const cu = cam[0], cv = cam[1]
      if (Math.abs(ox + l * 0.5 - cu) > reach + l * 0.5) continue
      if (Math.abs(oy + l * 0.5 - cv) > reach + l * 0.5) continue
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, ok = true
      const cx = new Float64Array(4), cz = new Float64Array(4)
      for (let c = 0; c < 4; c++) {
        const uu = ox + QUAD_CORNER_U[c] * l, vv = oy + QUAD_CORNER_V[c] * l
        if (!deformDir(face, uu, vv, R, _dir)) { ok = false; break }
        const wx = _dir[0] * R, wy = _dir[1] * R, wz = _dir[2] * R
        const px = wx * E[0] + wy * E[1] + wz * E[2]
        const pz = wx * N[0] + wy * N[1] + wz * N[2]
        cx[c] = px; cz[c] = pz
        if (px < minX) minX = px; if (px > maxX) maxX = px
        if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz
      }
      if (!ok) continue
      const gx = (cx[0] + cx[1] + cx[2] + cx[3]) * 0.25, gz = (cz[0] + cz[1] + cz[2] + cz[3]) * 0.25
      for (let c = 0; c < 4; c++) { cx[c] = gx + (cx[c] - gx) * FOOTPRINT_BLOAT; cz[c] = gz + (cz[c] - gz) * FOOTPRINT_BLOAT }
      near.push({ face, ox, oy, l, level, cx, cz, minX: minX - FOOTPRINT_INFLATE_M, maxX: maxX + FOOTPRINT_INFLATE_M, minZ: minZ - FOOTPRINT_INFLATE_M, maxZ: maxZ + FOOTPRINT_INFLATE_M })
    }
    stats.nearQuads = near.length
  }

  // A chart-local axis box of a rotated quad covers a lot of ground outside it, and every quad
  // it wrongly claims costs a 144-vertex materialisation, so the box only pre-rejects: the
  // actual test is winding-uniform containment in the quad's own corners.
  function insideQuad(q, x, z) {
    const cx = q.cx, cz = q.cz
    let sign = 0
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) & 3
      const cross = (cx[j] - cx[i]) * (z - cz[i]) - (cz[j] - cz[i]) * (x - cx[i])
      if (cross === 0) continue
      const s = cross > 0 ? 1 : -1
      if (sign === 0) sign = s
      else if (s !== sign) return false
    }
    return true
  }

  function heightAtLocal(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return MESH_SURFACE_NO_GROUND
    stats.queries++
    candidates.length = 0
    for (let k = 0; k < near.length; k++) {
      const n = near[k]
      if (x < n.minX || x > n.maxX || z < n.minZ || z > n.maxZ) continue
      if (!insideQuad(n, x, z)) continue
      candidates.push(n)
    }
    if (candidates.length === 0) { stats.unserved++; return MESH_SURFACE_NO_GROUND }
    candidates.sort((a, b) => a.l - b.l)
    for (let k = 0; k < candidates.length; k++) {
      const q = materialize(candidates[k])
      if (!q) continue
      const y = quadY(q, x, z)
      if (y !== null) { stats.served++; return y }
    }
    stats.unserved++
    return MESH_SURFACE_NO_GROUND
  }

  return {
    setFocus,
    sync,
    heightAtLocal,
    get version() { return version },
    stats: () => ({ ...stats, cachedQuads: built.size, gridSize }),
  }
}
