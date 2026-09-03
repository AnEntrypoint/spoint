// Dense ground grass, client-visual only (no colliders, no server parity contract). Salt-key block 20-26 must stay disjoint from VegPlacement (0-8) / RockPlacement (10-17).
import { hash3, rand, RELIEF_CALIBRATION_BASELINE } from './VegPlacement.js'

export const GRASS = Object.freeze({
  CHUNK: 32,
  CELL: 2,
  GRID: 16,
  JITTER: 0.9,
  SLOPE_D: 1.0,
  SLOPE_MAX: 0.9,
  WATER_MARGIN: 0.3,
  SEA_REJECT: -2,
  SCALE_MIN: 0.55,
  SCALE_SPAN: 0.85,
  BLADES_PER_CELL: 7,
  CLUMP_R: 0.95,
})

const K_JITX = 20, K_JITZ = 21, K_COIN = 22, K_SCALE = 23, K_YAW = 24, K_TINT = 25, K_WIND = 26

// Fixed approximate world sun direction for the cheap per-cell terrain-shadow scalar (classify() below).
// Matches the client's default directional-light elevation closely enough for an AO-like approximation;
// not wired to the live sun object (no such per-point sampling path exists in the placement pipeline --
// see grass-shadow-approximation-via-per-instance-cached-terrain-value PRD row), a static value is
// honest here rather than inventing a nonexistent dynamic-sun terrain query.
const _GRASS_SUN_DIR = (() => { const x = 0.4, y = 0.8, z = 0.3, l = Math.hypot(x, y, z); return [x / l, y / l, z / l] })()

const _clamp01 = (v) => v < 0 ? 0 : (v > 1 ? 1 : v)

export function grassDensity(temp, humidity, slopeRatio) {
  const wet = _clamp01(humidity), warm = _clamp01(temp), flat = 1 - _clamp01(slopeRatio)
  return _clamp01((0.18 + 0.78 * wet * (0.45 + 0.55 * warm)) * (0.25 + 0.75 * flat))
}

// Order matters: cheap climate/density-ceiling reject BEFORE any groundHeightLocal call (the dominant per-cell cost).
// cellIx/cellIz: the candidate's OWN pre-jitter grid index (stable per-candidate identity). Optional --
// falls back to rounding the passed x/z (matches prior behavior for direct/test callers with no grid
// context) -- but placeGrassCell MUST pass its own ix/iz explicitly, or the post-jitter x/z can round to a
// DIFFERENT cell's index (JITTER=0.9 is 45% of CELL=2, so this collision is common, not rare) and two
// spatially-distinct grass clumps silently draw the exact same blade layout/scale/tint (see
// RockPlacement.js's classify header for the same defect, live-witnessed there and fixed the identical way).
export function classify(x, z, frame, anchorField, h, cellIx, cellIz) {
  const clim = anchorField
    ? (anchorField.climateAtLocal ? anchorField.climateAtLocal(x, z) : anchorField.sampleDir(frame.localToDir(x, z)))
    : null
  const temp = clim && Number.isFinite(clim.temp) ? clim.temp : 0.5
  const humidity = clim && Number.isFinite(clim.humidity) ? clim.humidity : 0.5
  if (clim && Number.isFinite(clim.seaBias) && clim.seaBias < GRASS.SEA_REJECT) return null
  if (clim && clim.blocked) return null

  const ix = (cellIx !== undefined) ? cellIx : Math.round(x / GRASS.CELL)
  const iz = (cellIz !== undefined) ? cellIz : Math.round(z / GRASS.CELL)
  const cellHash = hash3(0x6a55 | 0, ix, iz)
  const coin = rand(cellHash, K_COIN)
  const ceiling = grassDensity(temp, humidity, 0)
  if (coin >= ceiling) return null

  const elev = (h !== undefined) ? h : frame.groundHeightLocal(x, z)
  if (!Number.isFinite(elev)) return null
  const _rk = ((frame && frame.reliefScale) || RELIEF_CALIBRATION_BASELINE) / RELIEF_CALIBRATION_BASELINE
  if (elev <= GRASS.WATER_MARGIN * _rk) return null

  const D = GRASS.SLOPE_D
  const hx1 = frame.groundHeightLocal(x + D, z), hx0 = frame.groundHeightLocal(x - D, z)
  const hz1 = frame.groundHeightLocal(x, z + D), hz0 = frame.groundHeightLocal(x, z - D)
  if (!Number.isFinite(hx1) || !Number.isFinite(hx0) || !Number.isFinite(hz1) || !Number.isFinite(hz0)) return null
  const dHdx = (hx1 - hx0) / (2 * D), dHdz = (hz1 - hz0) / (2 * D)
  const grad = Math.hypot(dHdx, dHdz)
  if (grad > GRASS.SLOPE_MAX) return null
  const slopeRatio = grad / (grad + 1)

  const accept = grassDensity(temp, humidity, slopeRatio)
  if (coin >= accept) return null

  // Cheap per-cell terrain self-shadow approximation reused as each blade's cached shadow value: the
  // slope gradient is already sampled above for density/placement, so deriving a terrain-normal-vs-sun
  // dot product here is free (no extra groundHeightLocal calls). This stands in for a real shadow-map
  // lookup -- Grass.js's shader samples ONE cached scalar per instance in the vertex stage instead of a
  // per-fragment PCF shadow-map fetch. Not a real occluder-cast shadow (no other geometry considered),
  // but a reasonable ambient-occlusion-like darkening on steep slopes facing away from the sun.
  const SUN_DIR = _GRASS_SUN_DIR
  const normX = -dHdx, normZ = -dHdz, normY = 1
  const nLen = Math.hypot(normX, normY, normZ) || 1
  const ndl = (normX * SUN_DIR[0] + normY * SUN_DIR[1] + normZ * SUN_DIR[2]) / nLen
  const cellShadow = Math.fround(_clamp01(0.55 + 0.45 * ndl))

  return { x: Math.fround(x), y: Math.fround(elev), z: Math.fround(z), cellHash, shadow: cellShadow }
}

function blade(cellHash, bi, x, y, z, cellShadow) {
  const h = hash3(cellHash | 0, bi + 1, 0)
  const ang = rand(h, K_YAW) * Math.PI * 2, rad = Math.sqrt(rand(h, K_JITX)) * GRASS.CLUMP_R
  return {
    x: Math.fround(x + Math.cos(ang) * rad), y, z: Math.fround(z + Math.sin(ang) * rad),
    scale: Math.fround(GRASS.SCALE_MIN + rand(h, K_SCALE) * GRASS.SCALE_SPAN),
    yaw: Math.fround(rand(h, K_YAW) * Math.PI * 2),
    tint: Math.fround(rand(h, K_TINT)),
    windPhase: Math.fround(rand(h, K_WIND) * Math.PI * 2),
    shadow: Number.isFinite(cellShadow) ? cellShadow : 1,
  }
}

// Shared by the atomic and incremental builders: both must iterate gz-outer/gx-inner for bit-identical ordered output.
function placeGrassCell(chunkX, chunkZ, gx, gz, frame, anchorField, seed, out) {
  const baseX = chunkX * GRASS.CHUNK, baseZ = chunkZ * GRASS.CHUNK
  const cellX = baseX + gx * GRASS.CELL + GRASS.CELL * 0.5
  const cellZ = baseZ + gz * GRASS.CELL + GRASS.CELL * 0.5
  const ix = Math.round(cellX / GRASS.CELL), iz = Math.round(cellZ / GRASS.CELL)
  const hh = hash3(seed, ix, iz)
  const jx = (rand(hh, K_JITX) * 2 - 1) * GRASS.JITTER
  const jz = (rand(hh, K_JITZ) * 2 - 1) * GRASS.JITTER
  // pass this candidate's OWN pre-jitter (ix,iz) explicitly so classify's cellHash never collides
  // with a neighboring cell's index after jitter is applied to x/z (see classify's header).
  const p = classify(cellX + jx, cellZ + jz, frame, anchorField, undefined, ix, iz)
  if (!p) return 0
  for (let b = 0; b < GRASS.BLADES_PER_CELL; b++) out.push(blade(p.cellHash, b, p.x, p.y, p.z, p.shadow))
  return GRASS.BLADES_PER_CELL
}

export function placementsForGrassChunk(chunkX, chunkZ, frame, anchorField, worldSeed) {
  const out = []
  const seed = (worldSeed | 0) ^ 0x6a55
  for (let gz = 0; gz < GRASS.GRID; gz++)
    for (let gx = 0; gx < GRASS.GRID; gx++)
      placeGrassCell(chunkX, chunkZ, gx, gz, frame, anchorField, seed, out)
  return out
}

// Incremental builder: step(budgetMs) spreads placement across frames; same order as placementsForGrassChunk -> bit-identical when done.
export function createGrassChunkCursor(chunkX, chunkZ, frame, anchorField, worldSeed, now) {
  const seed = (worldSeed | 0) ^ 0x6a55
  const clock = (typeof now === 'function') ? now : ((typeof performance !== 'undefined') ? () => performance.now() : () => 0)
  const blades = []
  let gx = 0, gz = 0, done = (GRASS.GRID <= 0)
  function step(budgetMs) {
    if (done) return done
    const t0 = clock()
    do {
      placeGrassCell(chunkX, chunkZ, gx, gz, frame, anchorField, seed, blades)
      if (++gx >= GRASS.GRID) { gx = 0; if (++gz >= GRASS.GRID) { done = true; break } }
    } while (clock() - t0 < budgetMs)
    return done
  }
  return { blades, step, get done() { return done } }
}
