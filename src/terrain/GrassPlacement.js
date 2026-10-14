import { hash3, rand, renderedSoilWeight, createPlacementCell, placementCellAt, surfaceOfCell } from './VegPlacement.js'
import { latticeFor, tangentFrame, tangentToLocal, tangentHeadingInChart, surfaceAlongDir, climateAt } from './PlacementChart.js'
import { paintedWeightsFor, paintedSlopeOf } from './PaintedWeights.js'

const _isNode = typeof process !== 'undefined' && process.versions?.node
const _mapspinnerFile = (p) => (_isNode ? `mapspinner/${p}` : `/node_modules/mapspinner/src/${p}`)
const { TERRAIN_DEFAULTS: TD } = await import(_mapspinnerFile('terrain-defaults.js'))
const { compileSnoise3 } = await import(_mapspinnerFile('tsl/ops-jsgen.js'))
const { HASH_VERSION_FLOAT } = await import(_mapspinnerFile('tsl/height-spec.js'))

export const GRASS = Object.freeze({
  CHUNK: 32,
  CELL: 2,
  GRID: 16,
  JITTER: 0.9,
  SLOPE_D: 1.0,
  SLOPE_MAX: 0.9,
  SEA_REJECT: -2,
  SCALE_MIN: 0.462,
  SCALE_SPAN: 3.213,
  BLADES_PER_CELL: 79,
  CLUMP_R: 1.15,
})

export const GRASS_DENSITY = Object.freeze({
  FULL_R: 16,
  P: 1.25,
  FADE_M: 5,
  LEAD_M: 6,
  EDGE_M: 8,
  GROW_MAX: 1.3,
  GROW_K: 0.005,
  FACE_START: 24,
  FACE_END: 44,
})

// The distance-density law: a blade's stable rank q is the coin that decided whether it exists at
// all, divided by the cell density it was drawn against, so it is uniform on [0,1) and never
// re-chosen. Dropping the blades with q >= f(d) removes exactly the fraction f(d) of them, and
// f(d) = (FULL_R / d) ** P is what makes the population grow as R ** (2 - P) and not R ** 2.
export function grassBladeEdgeM(q, fullR = GRASS_DENSITY.FULL_R, capM = Infinity) {
  const own = fullR / Math.pow(Math.max(q, 1e-4), 1 / GRASS_DENSITY.P) + GRASS_DENSITY.FADE_M
  return Math.min(own, capM)
}

export function grassKeepFractionAt(d, fullR = GRASS_DENSITY.FULL_R) {
  if (!(d > fullR)) return 1
  return Math.pow(fullR / d, GRASS_DENSITY.P)
}

// Surface reads one blade's own foot costs where the frame carries a drawn mesh: two converge it to
// 0.0000056 m worst case, a third moves nothing, and one leaves 0.0003824 m. Counted, so the
// witness can price a blade without re-deriving it.
export const GRASS_FOOT_READS = 2

const K_JITX = 20, K_JITZ = 21, K_COIN = 22, K_SCALE = 23, K_YAW = 24, K_TINT = 25, K_WIND = 26

const _GRASS_FIXED_APPROX_SUN_DIR = (() => { const x = 0.4, y = 0.8, z = 0.3, l = Math.hypot(x, y, z); return [x / l, y / l, z / l] })()

const _clamp01 = (v) => v < 0 ? 0 : (v > 1 ? 1 : v)

const BC = { shore: TD.bcShore, lowland: TD.bcLowland, grass: TD.bcGrass, rock: TD.bcRock, snow: TD.bcSnow }
const RIDGE_OCTAVES = [[75.0, 1.0, 0.0], [375.0, 0.6, 7.3]]
const RIDGE_AMP_SUM = 1.6

const _snoiseByHash = new Map()
function snoiseFor(hashVersion) {
  const key = hashVersion ?? HASH_VERSION_FLOAT
  let s = _snoiseByHash.get(key)
  if (!s) { s = compileSnoise3({ hashVersion: key }); _snoiseByHash.set(key, s) }
  return s
}

const _smooth = (a, b, x) => { const t = _clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t) }
const _mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

function biomeClimateRgb(snoise3, dir, h, rockSlope, temp) {
  const dx = dir[0], dy = dir[1], dz = dir[2]
  const rockT = _smooth(TD.slopeRock[0], TD.slopeRock[1], rockSlope)
  const depthT = _clamp01(-h / 300)
  const bed = _mix3(_mix3(BC.shore, [0.12, 0.11, 0.09], _smooth(0, 0.5, depthT)), [0.06, 0.06, 0.07], _smooth(0.5, 1, depthT))
  const seaOut = _mix3(_mix3(bed, BC.rock, rockT), [0.82, 0.88, 0.94], (1 - _smooth(0.12, 0.22, temp)) * 0.9)
  const lo = TD.bandEdgesLo, hi = TD.bandEdgesHi, sn = TD.snowEdges
  const land0 = _mix3(_mix3(BC.shore, BC.lowland, _smooth(0, lo[0], h)), BC.grass, _smooth(lo[0], lo[1], h))
  const warp = snoise3(dx * 130, dy * 130, dz * 130) * 0.004
  const bx = dx + warp, by = dy + warp, bz = dz + warp
  const bandWarp = (snoise3(bx * 210, by * 210, bz * 210) + 0.5 * snoise3(bx * 560, by * 560, bz * 560) + 0.25 * snoise3(bx * 1450, by * 1450, bz * 1450)) * TD.bandWarp
  const land1 = _mix3(land0, BC.rock, _smooth(bandWarp + hi[0], bandWarp + hi[1], h))
  const land2 = _mix3(land1, BC.snow, _smooth(bandWarp + sn[0], bandWarp + sn[1], h))
  const land3 = _mix3(land2, BC.rock, rockT * (h >= 0 ? 1 : 0))
  const mottle = snoise3(dx * 120, dy * 120, dz * 120) * TD.variationAmt + 1
  const beached = _mix3(land3.map((c) => c * mottle), BC.shore, (1 - _smooth(TD.beachTop * 0.3, TD.beachTop, h)) * (1 - rockT))
  let ridge = 0
  for (const [freq, amp, shift] of RIDGE_OCTAVES) ridge += amp * snoise3(dx * freq + shift, dy * freq + shift, dz * freq + shift)
  const ridgeGain = (ridge / RIDGE_AMP_SUM) * 0.02 + 1
  return h < 0 ? seaOut : beached.map((c) => c * ridgeGain)
}

function groundRgb(snoise3, dir, h, slope, temp, splat) {
  const biome = biomeClimateRgb(snoise3, dir, h, slope, temp)
  const surface = [0, 1, 2].map((c) => splat.grass * BC.grass[c] + splat.rock * TD.bcRock[c] + splat.sand * BC.shore[c] + splat.snow * BC.snow[c])
  const tinted = _mix3(surface, biome, TD.biomeTint * (1 - 0.85 * _clamp01(splat.sand)))
  return tinted.map((c) => _clamp01(c * TD.texBright))
}


export function grassDensity(temp, humidity, slopeRatio) {
  const wet = _clamp01(humidity), warm = _clamp01(temp), flat = 1 - _clamp01(slopeRatio)
  const base = (0.5 + 0.5 * wet * (0.45 + 0.55 * warm)) * (0.35 + 0.65 * flat)
  const dryBiome = _clamp01((wet - 0.05) / 0.15)
  const biome = dryBiome * dryBiome * (3 - 2 * dryBiome)
  return _clamp01(0.5 + 4 * (base * biome - 0.5))
}

const _jetProbe = [0, 0, 0]
const _jet = { dHdx: 0, dHdz: 0, kx: 0, kz: 0, at: null }
function grassJetAt(frame, tf, rho, stepM) {
  const d = tf.up, e = tf.east, n = tf.north
  const r = (sx, sz) => {
    const px = d[0] * rho + e[0] * sx + n[0] * sz, py = d[1] * rho + e[1] * sx + n[1] * sz, pz = d[2] * rho + e[2] * sx + n[2] * sz
    const l = Math.hypot(px, py, pz)
    return surfaceAlongDir(frame, px / l, py / l, pz / l, rho, _jetProbe)
  }
  const ex1 = r(stepM, 0), ex0 = r(-stepM, 0), nz1 = r(0, stepM), nz0 = r(0, -stepM)
  if (!Number.isFinite(ex1) || !Number.isFinite(ex0) || !Number.isFinite(nz1) || !Number.isFinite(nz0)) return null
  const s2 = stepM * stepM
  _jet.dHdx = (ex1 - ex0) / (2 * stepM)
  _jet.dHdz = (nz1 - nz0) / (2 * stepM)
  _jet.kx = (ex1 + ex0 - 2 * rho) / s2
  _jet.kz = (nz1 + nz0 - 2 * rho) / s2
  _jet.at = r
  return _jet
}

export function classify(frame, anchorField, cell) {
  const cellHash = hash3(0x6a55 | 0, cell.row, cell.j)
  const rho = surfaceOfCell(frame, cell)
  if (!Number.isFinite(rho)) return null
  const x = cell.at[0], groundY = cell.at[1], z = cell.at[2]
  const clim = climateAt(anchorField, x, z, cell.dir)
  const temp = clim && Number.isFinite(clim.temp) ? clim.temp : 0.5
  const humidity = clim && Number.isFinite(clim.humidity) ? clim.humidity : 0.5
  if (clim && Number.isFinite(clim.seaBias) && clim.seaBias < GRASS.SEA_REJECT) return null
  if (clim && clim.blocked) return null

  const soil = renderedSoilWeight(rho - frame.radius)
  if (soil <= 0) return null

  const tf = tangentFrame(frame, cell.dir[0], cell.dir[1], cell.dir[2])
  const jet = grassJetAt(frame, tf, rho, GRASS.SLOPE_D)
  if (!jet) return null
  const dHdx = jet.dHdx, dHdz = jet.dHdz, kx = jet.kx, kz = jet.kz
  // A blade is not placed at its cell centre: GRASS.CLUMP_R offsets it, and the height it needs is
  // the height AT THE OFFSET. It is read, not extrapolated from the cell's own gradient and
  // curvature -- the extrapolation is a second-order Taylor step over a clump a metre wide, and its
  // remainder is what put blades up to 0.24 m off the surface they were placed on.
  //
  // The read is taken off the frame's own drawn mesh, at the blade's own horizontal position, rather
  // than by solving along the blade's direction: a solve is a fixed point in the radius and costs
  // 2.35 reads of the SAME mesh (2.53 us a read, 5.94 us a solve -- the micro-benchmark in
  // scripts/grass-seam-card-witness.mjs), while a read converges in two because rise enters the
  // blade's (x,z) only through the up axis' own horizontal component. It is also the more accurate
  // of the two -- 0.0000003 / 0.0000013 / 0.0000056 m against the solve's 0.0000056 / 0.0000107 /
  // 0.0000423 m -- because it never carries a solve tolerance into the blade's foot.
  //
  // Where the frame carries no drawn mesh the solve is paid exactly as it was, and where neither
  // answers, the Taylor step is. Neither branch removes a blade or coarsens a cell.
  const sampleAt = jet.at
  const meshAt = typeof frame.renderMeshHeightAtLocal === 'function' ? frame.renderMeshHeightAtLocal : null
  const mE = tf.eastL, mU = tf.upL, mN = tf.northL
  const mInv = 1 / (mU[1] || 1)
  const bowl = (offE, offN) => dHdx * offE + dHdz * offN + 0.5 * (kx * offE * offE + kz * offN * offN)
  const riseAt = (offE, offN) => {
    if (meshAt !== null) {
      let rise = bowl(offE, offN), read = true
      for (let k = 0; k < GRASS_FOOT_READS; k++) {
        const y = meshAt(x + mE[0] * offE + mU[0] * rise + mN[0] * offN, z + mE[2] * offE + mU[2] * rise + mN[2] * offN)
        if (!Number.isFinite(y)) { read = false; break }
        rise = (y - groundY - mE[1] * offE - mN[1] * offN) * mInv
      }
      if (read) return rise
    }
    const at = sampleAt(offE, offN)
    return Number.isFinite(at) ? at - rho : bowl(offE, offN)
  }
  const grad = Math.hypot(dHdx, dHdz)
  if (grad > GRASS.SLOPE_MAX) return null
  const slopeRatio = grad / (grad + 1)
  const slopeP = paintedSlopeOf(dHdx, dHdz)
  const splat = paintedWeightsFor(frame.hashVersion)(cell.dir, rho - frame.radius, slopeP, temp, humidity)

  const density = _clamp01(grassDensity(temp, humidity, slopeRatio) * soil * splat.grass * cell.area)
  const ground = density > 0 ? groundRgb(snoiseFor(frame.hashVersion), cell.dir, rho - frame.radius, slopeP, temp, splat) : null

  const SUN_DIR = _GRASS_FIXED_APPROX_SUN_DIR
  const normX = -dHdx, normZ = -dHdz, normY = 1
  const nLen = Math.hypot(normX, normY, normZ) || 1
  const ndl = (normX * SUN_DIR[0] + normY * SUN_DIR[1] + normZ * SUN_DIR[2]) / nLen
  const cellShadow = Math.fround(_clamp01(0.55 + 0.45 * ndl))
  const surfNx = tf.upL[0] - dHdx * tf.eastL[0] - dHdz * tf.northL[0]
  const surfNy = tf.upL[1] - dHdx * tf.eastL[1] - dHdz * tf.northL[1]
  const surfNz = tf.upL[2] - dHdx * tf.eastL[2] - dHdz * tf.northL[2]
  const surfInv = 1 / (Math.hypot(surfNx, surfNy, surfNz) || 1)

  return {
    x, y: groundY, z, cellHash, density, ground, shadow: cellShadow, dHdx, dHdz, kx, kz, tf, riseAt, heading: tangentHeadingInChart(tf),
    nx: Math.fround(surfNx * surfInv), ny: Math.fround(surfNy * surfInv), nz: Math.fround(surfNz * surfInv),
  }
}

export function blade(p, bi) {
  const h = hash3(p.cellHash | 0, bi + 1, 0)
  const coin = rand(h, K_COIN)
  if (coin >= p.density) return null
  const ang = rand(h, K_YAW) * Math.PI * 2, rad = Math.sqrt(rand(h, K_JITX)) * GRASS.CLUMP_R
  const offE = Math.cos(ang) * rad, offN = Math.sin(ang) * rad
  const off = tangentToLocal(p.tf, offE, p.riseAt(offE, offN), offN)
  return {
    q: Math.fround(p.density > 0 ? coin / p.density : 1),
    x: Math.fround(p.x + off[0]), y: Math.fround(p.y + off[1]), z: Math.fround(p.z + off[2]),
    scale: Math.fround(GRASS.SCALE_MIN + rand(h, K_SCALE) * GRASS.SCALE_SPAN),
    yaw: Math.fround(rand(h, K_YAW) * Math.PI * 2 + p.heading),
    nx: p.nx, ny: p.ny, nz: p.nz,
    tint: Math.fround(rand(h, K_TINT)),
    windPhase: Math.fround(rand(h, K_WIND) * Math.PI * 2),
    shadow: Number.isFinite(p.shadow) ? p.shadow : 1,
    groundR: Math.fround(p.ground[0]), groundG: Math.fround(p.ground[1]), groundB: Math.fround(p.ground[2]),
  }
}

function placeGrassCell(frame, lattice, dec, gx, gz, anchorField, seed, cell, out) {
  placementCellAt(frame, lattice, dec, gx, gz, seed, GRASS.JITTER / GRASS.CELL, K_JITX, K_JITZ, cell)
  const p = classify(frame, anchorField, cell)
  if (!p) return 0
  let placed = 0
  for (let b = 0; b < GRASS.BLADES_PER_CELL; b++) {
    const bl = blade(p, b)
    if (bl) { out.push(bl); placed++ }
  }
  return placed
}

export function placementsForGrassChunk(key, frame, anchorField, worldSeed) {
  const cursor = createGrassChunkCursor(key, frame, anchorField, worldSeed, () => 0)
  cursor.step(Infinity)
  return cursor.blades
}

export function createGrassChunkCursor(key, frame, anchorField, worldSeed, now, abandoned) {
  const seed = (worldSeed | 0) ^ 0x6a55
  const lattice = latticeFor(frame, GRASS)
  const dec = lattice.decodeChunk(key, [0, 0, 0])
  const cell = createPlacementCell(frame)
  const clock = (typeof now === 'function') ? now : ((typeof performance !== 'undefined') ? () => performance.now() : () => 0)
  const blades = []
  let gx = 0, gz = 0, done = (GRASS.GRID <= 0)
  function step(budgetMs) {
    if (done) return done
    const t0 = clock()
    do {
      placeGrassCell(frame, lattice, dec, gx, gz, anchorField, seed, cell, blades)
      if (abandoned !== undefined && abandoned()) { done = true; break }
      if (++gx >= GRASS.GRID) { gx = 0; if (++gz >= GRASS.GRID) { done = true; break } }
    } while (clock() - t0 < budgetMs)
    return done
  }
  return { blades, step, get done() { return done } }
}
