// Single source of truth for rock placement: same primitives as VegPlacement.js so the client-rendered rock matches the server collider (RockPhysics.js) byte-identically.
// Salt-key block (10-17) must not overlap VegPlacement's (0-6) or the two placement streams correlate.

import { hash3, rand, trunkIdOf, ARIDITY_LINE, RELIEF_CALIBRATION_BASELINE, VEG } from './VegPlacement.js'

export const ROCK = Object.freeze({
  CHUNK: 32,
  CELL: 8,
  GRID: 4,
  JITTER: 3.2,
  SLOPE_D: 1.5,
  WATER_MARGIN: 0.3,
  SEA_REJECT: -2,
  TYPES: 6,
  FLOOR: 0.025,
  SCALE_MIN: 2.0,
  SCALE_SPAN: 8.0,
})

const K_COIN = 10, K_TYPE = 11, K_SCALE = 12, K_YAW = 13, K_TILTX = 14, K_TILTZ = 15, K_SQUASH = 16, K_VAR = 17

export function rockDensity(erosion, slopeRatio, humidity, elevNorm) {
  const ero = Math.max(0, Math.min(1, erosion))
  const slope = Math.max(0, Math.min(1, slopeRatio))
  const hum = Math.max(0, Math.min(1, humidity))
  // Sand/desert biome boost: imports ARIDITY_LINE from VegPlacement.js (single source of truth for the
  // canonical sand/desert threshold across every placement stream) instead of re-hardcoding it, so
  // "sand biome" means the same humidity band everywhere by construction, not by two literals staying
  // in sync manually. Below the line the boost ramps smoothly from 1x (right at the line) up to a real
  // 2x at bone-dry (humidity 0) -- the prior flat 1.25x barely nudged the multiplicative chain and was
  // not visually distinguishable as "sand gets noticeably more rocks."
  const arid = hum < ARIDITY_LINE ? 1 + (1 - hum / ARIDITY_LINE) : 1.0
  const band = 0.6 + 0.4 * Math.max(0, Math.min(1, elevNorm))
  const d = (0.15 + 0.85 * ero) * (0.4 + 1.6 * slope * slope) * arid * band
  return Math.max(ROCK.FLOOR, Math.min(1, d))
}

// quaternion rotating +Y onto surface normal n; uncapped so rocks lie flush with slope (no rejects, rocks belong on cliffs).
function normalQuat(nx, ny, nz, out) {
  let dot = ny
  if (dot > 1) dot = 1; else if (dot < -1) dot = -1
  const ang = Math.acos(dot)
  let ax = nz, az = -nx
  const al = Math.hypot(ax, az)
  if (al < 1e-6) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1; return out }
  ax /= al; az /= al
  const s = Math.sin(ang / 2)
  out[0] = Math.fround(ax * s); out[1] = 0; out[2] = Math.fround(az * s); out[3] = Math.fround(Math.cos(ang / 2))
  return out
}

const PATCH = 112

// corner values memoized: pure fn of integer lattice indices, same on client+server, only avoids recompute.
// Bounded (insertion-order eviction): a long-lived server process or a client roaming a whole planet
// would otherwise grow these memo maps without limit -- values are pure functions of the lattice index,
// so eviction only ever costs a recompute, never a different answer. 8192 entries covers a ~10km span of
// the 112m/224m lattices, far beyond any streamed ring.
const CORNER_CACHE_MAX = 8192
const _cornerCache = new Map()
function cornerValue(ix, iz) {
  const k = ((ix & 0x3fffff) * 0x400000) + (iz & 0x3fffff)
  let v = _cornerCache.get(k)
  if (v !== undefined) return v
  v = rand(hash3(0x70c1 | 0, ix, iz), 0)
  _cornerCache.set(k, v)
  if (_cornerCache.size > CORNER_CACHE_MAX) _cornerCache.delete(_cornerCache.keys().next().value)
  return v
}

function patchDensity(x, z) {
  const fx = x / PATCH, fz = z / PATCH
  const ix = Math.floor(fx), iz = Math.floor(fz)
  let tx = fx - ix, tz = fz - iz
  tx = tx * tx * (3 - 2 * tx); tz = tz * tz * (3 - 2 * tz)
  const c00 = cornerValue(ix, iz), c10 = cornerValue(ix + 1, iz)
  const c01 = cornerValue(ix, iz + 1), c11 = cornerValue(ix + 1, iz + 1)
  const a = c00 + (c10 - c00) * tx, b = c01 + (c11 - c01) * tx
  return a + (b - a) * tz
}

// Size-correlated clustering: a SEPARATE, coarser (CLUSTER_SCALE >> PATCH) bilinear lattice than
// patchDensity's -- clustering is a REGIONAL effect (several rock-cells wide), not a per-cell one, and a
// distinct hash salt (0x70c2, its own corner cache) keeps it uncorrelated with the unrelated general
// density patch noise. ONE noise sample per (x,z) drives BOTH an instance's size bias AND its local
// density multiplier, so "big rocks nearby" and "more rocks nearby" are the SAME field by construction --
// a region that rolls high naturally gets both larger AND more numerous rocks (clusters); a region that
// rolls low gets both smaller AND sparser rocks (spread apart). Pure fn of world (x,z), same lattice
// on client+server -> parity-safe (no new RNG stream, no per-instance-only state).
const CLUSTER_SCALE = 224
const _clusterCornerCache = new Map()
function clusterCornerValue(ix, iz) {
  const k = ((ix & 0x3fffff) * 0x400000) + (iz & 0x3fffff)
  let v = _clusterCornerCache.get(k)
  if (v !== undefined) return v
  v = rand(hash3(0x70c2 | 0, ix, iz), 0)
  _clusterCornerCache.set(k, v)
  if (_clusterCornerCache.size > CORNER_CACHE_MAX) _clusterCornerCache.delete(_clusterCornerCache.keys().next().value)
  return v
}
// Returns [0,1]; 0.5 is neutral (no bias). >0.5 = "big rock region" (denser + larger), <0.5 = "small rock
// region" (sparser + smaller).
function sizeClusterField(x, z) {
  const fx = x / CLUSTER_SCALE, fz = z / CLUSTER_SCALE
  const ix = Math.floor(fx), iz = Math.floor(fz)
  let tx = fx - ix, tz = fz - iz
  tx = tx * tx * (3 - 2 * tx); tz = tz * tz * (3 - 2 * tz)
  const c00 = clusterCornerValue(ix, iz), c10 = clusterCornerValue(ix + 1, iz)
  const c01 = clusterCornerValue(ix, iz + 1), c11 = clusterCornerValue(ix + 1, iz + 1)
  const a = c00 + (c10 - c00) * tx, b = c01 + (c11 - c01) * tx
  return a + (b - a) * tz
}

// cellIx/cellIz: the candidate's OWN pre-jitter grid index (stable per-candidate identity). Optional --
// falls back to rounding the passed x/z (matches prior behavior for direct/test callers with no grid
// context) -- but placementsForRockChunk MUST pass its own ix/iz explicitly, or the post-jitter x/z can
// round to a DIFFERENT cell's index (JITTER=3.2 is 40% of CELL=8, so this collision is common, not rare)
// and two spatially-distinct rocks silently draw the exact same type/scale/yaw/squash/variant (the
// "rocks near each other look uniform in size/rotation" defect -- live-witnessed: two live-placed rocks
// ~5m apart with byte-identical scale 3.2804 and yaw 0.1745, traced to both jittered positions rounding
// to ix=14,iz=5 despite different origin cells 2,0 and 1,1).
export function classify(x, z, frame, anchorField, h, cellIx, cellIz) {
  const elev = (h !== undefined) ? h : frame.groundHeightLocal(x, z)
  if (!Number.isFinite(elev)) return null
  const _rk = ((frame && frame.reliefScale) || RELIEF_CALIBRATION_BASELINE) / RELIEF_CALIBRATION_BASELINE
  if (elev <= ROCK.WATER_MARGIN * _rk) return null

  const clim = anchorField
    ? (anchorField.climateAtLocal ? anchorField.climateAtLocal(x, z) : anchorField.sampleDir(frame.localToDir(x, z)))
    : null
  const erosion = clim && Number.isFinite(clim.erosion) ? clim.erosion : 0.3
  const humidity = clim && Number.isFinite(clim.humidity) ? clim.humidity : 0.5
  if (clim && Number.isFinite(clim.seaBias) && clim.seaBias < ROCK.SEA_REJECT) return null
  if (clim && clim.blocked) return null

  // shares VEG.TREELINE (not a separately-hardcoded 4000) so rock elevation banding and tree treeline
  // normalization never silently diverge -- see ARIDITY_LINE/RELIEF_CALIBRATION_BASELINE above for the
  // same single-source-of-truth pattern.
  const elevNorm = Math.max(0, Math.min(1, elev / VEG.TREELINE))
  const ix = (cellIx !== undefined) ? cellIx : Math.round(x / ROCK.CELL)
  const iz = (cellIz !== undefined) ? cellIz : Math.round(z / ROCK.CELL)
  const cellHash = hash3(0x70c | 0, ix, iz)
  const patch = 0.25 + 1.5 * patchDensity(x, z)
  // Size-correlated clustering field (see sizeClusterField header): sampled once per candidate at its
  // OWN world (x,z) so the density boost here and the scale bias below share the identical value --
  // this is what makes "big rock region" and "dense rock region" the same region by construction.
  const cluster = sizeClusterField(x, z)
  const coin = rand(cellHash, K_COIN)
  // ceiling must upper-bound accept's clustering term over EVERY possible clusterStrength in [0,0.6], not
  // just clusterStrength=0.6 (flat ground): clusterStrength=0.6*(1-slopeRatio) SHRINKS toward 0 as slope
  // steepens, and when cluster<0.5 a smaller clusterStrength makes (1+clusterStrength*(cluster-0.5)) LARGER
  // (the negative term shrinks toward 0), not smaller -- so the true worst case for cluster<0.5 is
  // clusterStrength=0 (factor 1, no reduction), while for cluster>=0.5 it's still clusterStrength=0.6 (matches
  // below). max(0, cluster-0.5) picks the correct branch; using the flat-ground 0.6*(cluster-0.5) directly
  // let ceiling dip BELOW the real accept density on steep+eroded+cluster<0.5 cells, early-rejecting rocks
  // that the real slope-aware density would have placed -- this was the missing-rock-coverage-on-cliffs bug.
  const ceiling = Math.max(ROCK.FLOOR, Math.min(1, rockDensity(erosion, 1, humidity, elevNorm) * patch * (1 + 0.6 * Math.max(0, cluster - 0.5))))
  if (coin >= ceiling) return null // fails even at max slope -> skip the 4 slope samples below

  const D = ROCK.SLOPE_D
  const hx1 = frame.groundHeightLocal(x + D, z), hx0 = frame.groundHeightLocal(x - D, z)
  const hz1 = frame.groundHeightLocal(x, z + D), hz0 = frame.groundHeightLocal(x, z - D)
  if (!Number.isFinite(hx1) || !Number.isFinite(hx0) || !Number.isFinite(hz1) || !Number.isFinite(hz0)) return null
  const dHdx = (hx1 - hx0) / (2 * D), dHdz = (hz1 - hz0) / (2 * D)
  const grad = Math.hypot(dHdx, dHdz)
  const slopeRatio = grad / (grad + 1)

  let nx = -dHdx, ny = 1, nz = -dHdz
  const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl

  // Clustering strength is modulated by flat-vs-slope: full +-30% density swing on flat ground (where
  // erosion/slope aren't already dominating placement), tapering toward neutral (1x, no clustering bias)
  // as slope steepens -- a cliff's rock scatter should stay driven by erosion/gradient, not regional size
  // clustering. (1 - slopeRatio) is 1 on flat ground, ->0 as slopeRatio->1 on a cliff face.
  const clusterStrength = 0.6 * (1 - slopeRatio)
  const accept = Math.max(ROCK.FLOOR, Math.min(1, rockDensity(erosion, slopeRatio, humidity, elevNorm) * patch * (1 + clusterStrength * (cluster - 0.5))))
  if (coin >= accept) return null

  const type = Math.floor(rand(cellHash, K_TYPE) * ROCK.TYPES) % ROCK.TYPES
  const sc = rand(cellHash, K_SCALE)
  // Same cluster field biases the scale roll: a "big rock region" (cluster>0.5) skews sc upward toward
  // 1 (bigger rocks), a "small rock region" (cluster<0.5) skews it down toward 0 -- capped to [0,1] so
  // the existing SCALE_MIN/SCALE_SPAN band (and every downstream consumer of it) is untouched.
  const scBiased = Math.max(0, Math.min(1, sc + (cluster - 0.5) * 0.6))
  const scale = Math.fround(ROCK.SCALE_MIN + scBiased * scBiased * scBiased * ROCK.SCALE_SPAN)
  const yaw = Math.fround(rand(cellHash, K_YAW) * Math.PI * 2)
  const wob = (rand(cellHash, K_TILTX) - 0.5) * 0.12, wobZ = (rand(cellHash, K_TILTZ) - 0.5) * 0.12
  const squash = Math.fround(0.55 + rand(cellHash, K_SQUASH) * 0.55)
  const variant = Math.fround(rand(cellHash, K_VAR))
  let bnx = nx + wob, bny = ny, bnz = nz + wobZ
  const bl = Math.hypot(bnx, bny, bnz); bnx /= bl; bny /= bl; bnz /= bl
  const tq = normalQuat(bnx, bny, bnz, [0, 0, 0, 1])

  return {
    x: Math.fround(x), y: Math.fround(elev), z: Math.fround(z),
    type, scale, yaw, squash, variant,
    normal: [Math.fround(nx), Math.fround(ny), Math.fround(nz)], tiltQuat: tq,
    rockId: trunkIdOf(x, z),
  }
}

// Shared by the atomic and incremental builders: both iterate gz-outer/gx-inner so the incremental
// cursor's output is bit-identical (same order, same values) to placementsForRockChunk's.
function placeRockCell(chunkX, chunkZ, gx, gz, frame, anchorField, seed, out) {
  const baseX = chunkX * ROCK.CHUNK, baseZ = chunkZ * ROCK.CHUNK
  const cellX = baseX + gx * ROCK.CELL + ROCK.CELL * 0.5
  const cellZ = baseZ + gz * ROCK.CELL + ROCK.CELL * 0.5
  const ix = Math.round(cellX / ROCK.CELL), iz = Math.round(cellZ / ROCK.CELL)
  const hh = hash3(seed, ix, iz)
  const jx = (rand(hh, 0) * 2 - 1) * ROCK.JITTER
  const jz = (rand(hh, 1) * 2 - 1) * ROCK.JITTER
  // pass this candidate's OWN pre-jitter (ix,iz) explicitly so classify's property hash never
  // collides with a neighboring cell's index after jitter is applied to x/z (see classify's header).
  const p = classify(cellX + jx, cellZ + jz, frame, anchorField, undefined, ix, iz)
  if (p) out.push(p)
}

export function placementsForRockChunk(chunkX, chunkZ, frame, anchorField, worldSeed) {
  const out = []
  const seed = (worldSeed | 0) ^ 0x70c5
  for (let gz = 0; gz < ROCK.GRID; gz++) {
    for (let gx = 0; gx < ROCK.GRID; gx++) {
      placeRockCell(chunkX, chunkZ, gx, gz, frame, anchorField, seed, out)
    }
  }
  return out
}

// Incremental builder (same shape as GrassPlacement.createGrassChunkCursor / VegPlacement.createVegChunkCursor):
// step(budgetMs) spreads one chunk's 16 cell classifications across ticks; `list` is order- and
// value-identical to placementsForRockChunk once `done`. step(Infinity) completes synchronously.
export function createRockChunkCursor(chunkX, chunkZ, frame, anchorField, worldSeed, now) {
  const seed = (worldSeed | 0) ^ 0x70c5
  const clock = (typeof now === 'function') ? now : ((typeof performance !== 'undefined') ? () => performance.now() : () => 0)
  const list = []
  let gx = 0, gz = 0, done = (ROCK.GRID <= 0)
  function step(budgetMs) {
    if (done) return done
    const t0 = clock()
    do {
      placeRockCell(chunkX, chunkZ, gx, gz, frame, anchorField, seed, list)
      if (++gx >= ROCK.GRID) { gx = 0; if (++gz >= ROCK.GRID) { done = true; break } }
    } while (clock() - t0 < budgetMs)
    return done
  }
  return { list, step, get done() { return done } }
}
