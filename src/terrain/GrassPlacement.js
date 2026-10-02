import { hash3, rand, renderedSoilWeight, createPlacementCell, placementCellAt, surfaceOfCell } from './VegPlacement.js'
import { latticeFor, tangentFrame, tangentToLocal, tangentHeadingInChart, radialSlopeAt, climateAt } from './PlacementChart.js'
import { paintedWeightsFor, paintedSlopeOf } from './PaintedWeights.js'

export const GRASS = Object.freeze({
  CHUNK: 32,
  CELL: 2,
  GRID: 16,
  JITTER: 0.9,
  SLOPE_D: 1.0,
  SLOPE_MAX: 0.9,
  SEA_REJECT: -2,
  SCALE_MIN: 0.55,
  SCALE_SPAN: 0.85,
  BLADES_PER_CELL: 11,
  CLUMP_R: 1.15,
})

const K_JITX = 20, K_JITZ = 21, K_COIN = 22, K_SCALE = 23, K_YAW = 24, K_TINT = 25, K_WIND = 26

const _GRASS_FIXED_APPROX_SUN_DIR = (() => { const x = 0.4, y = 0.8, z = 0.3, l = Math.hypot(x, y, z); return [x / l, y / l, z / l] })()

const _clamp01 = (v) => v < 0 ? 0 : (v > 1 ? 1 : v)


export function grassDensity(temp, humidity, slopeRatio) {
  const wet = _clamp01(humidity), warm = _clamp01(temp), flat = 1 - _clamp01(slopeRatio)
  return _clamp01((0.5 + 0.5 * wet * (0.45 + 0.55 * warm)) * (0.35 + 0.65 * flat))
}

export function classify(frame, anchorField, cell) {
  const cellHash = hash3(0x6a55 | 0, cell.row, cell.j)
  const coin = rand(cellHash, K_COIN)
  if (coin >= cell.area) return null

  const rho = surfaceOfCell(frame, cell)
  if (!Number.isFinite(rho)) return null
  const x = cell.at[0], groundY = cell.at[1], z = cell.at[2]
  const clim = climateAt(anchorField, x, z, cell.dir)
  const temp = clim && Number.isFinite(clim.temp) ? clim.temp : 0.5
  const humidity = clim && Number.isFinite(clim.humidity) ? clim.humidity : 0.5
  if (clim && Number.isFinite(clim.seaBias) && clim.seaBias < GRASS.SEA_REJECT) return null
  if (clim && clim.blocked) return null

  const ceiling = grassDensity(temp, humidity, 0) * cell.area
  if (coin >= ceiling) return null
  const soil = renderedSoilWeight(rho - frame.radius)
  if (soil <= 0 || coin >= ceiling * soil) return null

  const tf = tangentFrame(frame, cell.dir[0], cell.dir[1], cell.dir[2])
  const slope = radialSlopeAt(frame, tf, rho, GRASS.SLOPE_D)
  if (!slope) return null
  const dHdx = slope[0], dHdz = slope[1]
  const grad = Math.hypot(dHdx, dHdz)
  if (grad > GRASS.SLOPE_MAX) return null
  const slopeRatio = grad / (grad + 1)
  const paintedGrass = paintedWeightsFor(frame.hashVersion)(cell.dir, rho - frame.radius, paintedSlopeOf(dHdx, dHdz), temp, humidity).grass

  const accept = grassDensity(temp, humidity, slopeRatio) * soil * paintedGrass * cell.area
  if (coin >= accept) return null

  const SUN_DIR = _GRASS_FIXED_APPROX_SUN_DIR
  const normX = -dHdx, normZ = -dHdz, normY = 1
  const nLen = Math.hypot(normX, normY, normZ) || 1
  const ndl = (normX * SUN_DIR[0] + normY * SUN_DIR[1] + normZ * SUN_DIR[2]) / nLen
  const cellShadow = Math.fround(_clamp01(0.55 + 0.45 * ndl))

  return { x, y: groundY, z, cellHash, shadow: cellShadow, dHdx, dHdz, tf, heading: tangentHeadingInChart(tf) }
}

function blade(p, bi) {
  const h = hash3(p.cellHash | 0, bi + 1, 0)
  const ang = rand(h, K_YAW) * Math.PI * 2, rad = Math.sqrt(rand(h, K_JITX)) * GRASS.CLUMP_R
  const offE = Math.cos(ang) * rad, offN = Math.sin(ang) * rad
  const off = tangentToLocal(p.tf, offE, p.dHdx * offE + p.dHdz * offN, offN)
  return {
    x: Math.fround(p.x + off[0]), y: Math.fround(p.y + off[1]), z: Math.fround(p.z + off[2]),
    scale: Math.fround(GRASS.SCALE_MIN + rand(h, K_SCALE) * GRASS.SCALE_SPAN),
    yaw: Math.fround(rand(h, K_YAW) * Math.PI * 2 + p.heading),
    tint: Math.fround(rand(h, K_TINT)),
    windPhase: Math.fround(rand(h, K_WIND) * Math.PI * 2),
    shadow: Number.isFinite(p.shadow) ? p.shadow : 1,
  }
}

function placeGrassCell(frame, lattice, dec, gx, gz, anchorField, seed, cell, out) {
  placementCellAt(frame, lattice, dec, gx, gz, seed, GRASS.JITTER / GRASS.CELL, K_JITX, K_JITZ, cell)
  const p = classify(frame, anchorField, cell)
  if (!p) return 0
  for (let b = 0; b < GRASS.BLADES_PER_CELL; b++) out.push(blade(p, b))
  return GRASS.BLADES_PER_CELL
}

export function placementsForGrassChunk(key, frame, anchorField, worldSeed) {
  const cursor = createGrassChunkCursor(key, frame, anchorField, worldSeed, () => 0)
  cursor.step(Infinity)
  return cursor.blades
}

export function createGrassChunkCursor(key, frame, anchorField, worldSeed, now) {
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
      if (++gx >= GRASS.GRID) { gx = 0; if (++gz >= GRASS.GRID) { done = true; break } }
    } while (clock() - t0 < budgetMs)
    return done
  }
  return { blades, step, get done() { return done } }
}
