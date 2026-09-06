// Single source of truth for tree placement: imported verbatim by both client visual (Vegetation.js) and server physics (VegPhysics.js) so the trunk a player sees is byte-identical to the trunk collided.
// Parity discipline (any violation desyncs client vs server): integer-only hashing (never Math.random/Date), a fixed salt-key table + fixed evaluation order, Math.fround at every emit, insertion-order-only output (no sort).

export const VEG = Object.freeze({
  CHUNK: 32,
  CELL: 4,
  GRID: 8,
  JITTER: 1.8,
  SLOPE_D: 1.5,
  SLOPE_MAX: 0.6,
  WATER_MARGIN: 0.5,
  SEA_REJECT: -2,
  TREELINE: 4000,
  TREELINE_FADE: 120,
  TILT_CAP: 0.4363,
  SCALE_MIN: 0.75,
  SCALE_SPAN: 0.50,
})

// Must match apps/maps/veg/veg-manifest.json + worldDef species list + VegPhysics capsule table. Append-only: index is the stable wire id, never reorder 0-4.
export const SPECIES = Object.freeze([
  'Oak Large', 'Pine Medium', 'Aspen Medium', 'Ash Medium', 'Bush',   // 0-4 (frozen original order)
  'Ash Small', 'Ash Large', 'Aspen Small', 'Aspen Large', 'Bush 2',   // 5-9
  'Bush 3', 'Oak Small', 'Oak Medium', 'Pine Small', 'Pine Large',    // 10-14
])
const SP_OAK = 0, SP_PINE = 1, SP_ASPEN = 2, SP_ASH = 3, SP_BUSH = 4
const SP_ASH_S = 5, SP_ASH_L = 6, SP_ASPEN_S = 7, SP_ASPEN_L = 8, SP_BUSH2 = 9
const SP_BUSH3 = 10, SP_OAK_S = 11, SP_OAK_M = 12, SP_PINE_S = 13, SP_PINE_L = 14

// Fixed salt-key table -- each rand() consumer uses its own key so streams never correlate; reorder/reuse changes the forest.
const K_JITX = 0, K_JITZ = 1, K_COIN = 2, K_VARIANT = 3, K_YAW = 4, K_SCALE = 5, K_WIND = 6, K_SPECIESH = 7, K_SIZE = 8

const SIZE_SIBLINGS = {
  [SP_OAK]: [SP_OAK_S, SP_OAK_M, SP_OAK],
  [SP_PINE]: [SP_PINE_S, SP_PINE, SP_PINE_L],
  [SP_ASPEN]: [SP_ASPEN_S, SP_ASPEN, SP_ASPEN_L],
  [SP_ASH]: [SP_ASH_S, SP_ASH, SP_ASH_L],
  [SP_BUSH]: [SP_BUSH, SP_BUSH2, SP_BUSH3],
}
function sizeSibling(genus, sizeR, elevNorm) {
  const sibs = SIZE_SIBLINGS[genus]
  if (!sibs) return genus
  const p = sizeR * 0.7 + (1 - Math.max(0, Math.min(1, elevNorm))) * 0.3
  const idx = p < 0.40 ? 0 : (p < 0.75 ? 1 : 2)
  return sibs[idx]
}

// 32-bit integer hash (Math.imul + >>>0 only -> identical on every JS engine/float width, required for parity).
export function hash3(seed, ix, iz) {
  let h = seed | 0
  h = Math.imul(h ^ (ix | 0), 0x27d4eb2d) >>> 0
  h = Math.imul(h ^ (iz | 0), 0x165667b1) >>> 0
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39) >>> 0
  h ^= h >>> 15
  return h >>> 0
}

export function rand(h, k) {
  let x = (h ^ Math.imul((k | 0) + 1, 0x9e3779b1)) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0
  x ^= x >>> 13
  return (x >>> 0) / 4294967296
}

// stable per-trunk id (server collider <-> client visual match key): morton of 4cm-quantized x,z.
export function trunkIdOf(x, z) {
  const qx = (Math.round(x / 0.04) & 0xffff) >>> 0
  const qz = (Math.round(z / 0.04) & 0xffff) >>> 0
  let m = 0
  for (let i = 0; i < 16; i++) m |= ((qx >> i) & 1) << (2 * i) | ((qz >> i) & 1) << (2 * i + 1)
  return m >>> 0
}

// Canonical sand/desert aridity threshold, shared with RockPlacement.js's rockDensity (imported from
// here, not re-hardcoded) so "sand biome" means the same humidity band across every placement stream.
export const ARIDITY_LINE = 0.28

// Calibration baseline reliefScale that WATER_MARGIN/TREELINE/TREELINE_FADE (this file) and every other
// placement stream's own margin constants (RockPlacement.WATER_MARGIN, GrassPlacement.WATER_MARGIN) were
// originally tuned against. Every placement stream derives its own `_rk = frame.reliefScale / <this>`
// scale factor so those margins stay correct as reliefScale changes -- shared from here (not each module
// re-hardcoding its own copy of "0.01") so the three streams' gates can't silently diverge if this ever
// gets retuned. NOT the same constant as PlanetFrame.js's `_reliefScale` fallback default (that one is
// "what value to assume when reliefScale is unset at all"; this one is "what value the margin constants
// below were tuned at" -- they coincide numerically today but are conceptually independent).
export const RELIEF_CALIBRATION_BASELINE = 0.01

export function speciesFor(temp, humidity, elevNorm, vT = 0, vH = 0) {
  const t = Math.round((temp + vT) * 10) / 10
  const h = Math.round((humidity + vH) * 10) / 10
  // Aridity (sand/desert) gates FIRST and on the RAW (unjittered) humidity: a sand cell stays
  // shrub-only regardless of elevation/cold temperature AND regardless of the micro-climate jitter
  // (vH up to +-0.25) -- gating on the jittered `h` here let a true-desert cell (base humidity as
  // low as ~0.03-0.28) roll a high jitter draw, cross the ARIDITY_LINE, and grow a full tree (trees on
  // sand). The jitter still drives which TREE GENUS appears once a cell is already non-arid (h below).
  if (Math.round(humidity * 10) / 10 < ARIDITY_LINE) return SP_BUSH
  if (elevNorm > 0.62 || t < 0.30) return SP_PINE
  if (t > 0.62 && h > 0.55) return SP_OAK
  if (h > 0.50) return SP_ASH
  return SP_ASPEN
}

export function baseDensity(temp, humidity, erosion = 0) {
  const wet = Math.max(0, Math.min(1, humidity))
  const warm = Math.max(0, Math.min(1, temp))
  const ero = Math.max(0, Math.min(1, erosion))
  return (0.12 + 0.73 * wet * (0.4 + 0.6 * warm)) * (1 - 0.45 * ero)
}

const VEG_UP_NORMAL = Object.freeze([0, 1, 0])

// cellIx/cellIz: the candidate's OWN pre-jitter grid index (stable per-candidate identity). Optional --
// falls back to rounding the passed x/z (matches prior behavior for direct/test callers with no grid
// context) -- but placementsForChunk MUST pass its own ix/iz explicitly, or the post-jitter x/z can round
// to a DIFFERENT cell's index (JITTER=1.8 is 45% of CELL=4, so this collision is common, not rare) and two
// spatially-distinct trees silently draw the exact same species/scale/yaw/windPhase (see RockPlacement.js's
// classify header for the same defect, live-witnessed there and fixed the identical way).
export function classify(x, z, frame, anchorField, h, cellIx, cellIz) {
  const clim = anchorField
    ? (anchorField.climateAtLocal ? anchorField.climateAtLocal(x, z) : anchorField.sampleDir(frame.localToDir(x, z)))
    : null
  const temp = clim && Number.isFinite(clim.temp) ? clim.temp : 0.5
  const humidity = clim && Number.isFinite(clim.humidity) ? clim.humidity : 0.5
  const erosion = clim && Number.isFinite(clim.erosion) ? clim.erosion : 0.3
  if (clim && Number.isFinite(clim.seaBias) && clim.seaBias < VEG.SEA_REJECT) return null
  if (clim && clim.blocked) return null

  const base = baseDensity(temp, humidity, erosion)
  const ix = (cellIx !== undefined) ? cellIx : Math.round(x / VEG.CELL)
  const iz = (cellIz !== undefined) ? cellIz : Math.round(z / VEG.CELL)
  const cellHash = hash3(0x5eed | 0, ix, iz)
  const coin = rand(cellHash, K_COIN)
  if (coin >= base) return null // fails at full density -> skip the height sample

  const elev = (h !== undefined) ? h : frame.groundHeightLocal(x, z)
  if (!Number.isFinite(elev)) return null
  // elev is in post-reliefScale metres; gates must scale with world relief or a flat world grows nothing. _rk=1 at the RELIEF_CALIBRATION_BASELINE.
  const _rk = ((frame && frame.reliefScale) || RELIEF_CALIBRATION_BASELINE) / RELIEF_CALIBRATION_BASELINE
  if (elev <= VEG.WATER_MARGIN * _rk) return null
  if (elev > VEG.TREELINE * _rk) {
    const treelineMul = 1 - (elev - VEG.TREELINE * _rk) / (VEG.TREELINE_FADE * _rk)
    if (treelineMul <= 0 || coin >= base * treelineMul) return null
  }

  const D = VEG.SLOPE_D
  const hx1 = frame.groundHeightLocal(x + D, z), hx0 = frame.groundHeightLocal(x - D, z)
  const hz1 = frame.groundHeightLocal(x, z + D), hz0 = frame.groundHeightLocal(x, z - D)
  if (!Number.isFinite(hx1) || !Number.isFinite(hx0) || !Number.isFinite(hz1) || !Number.isFinite(hz0)) return null
  const dHdx = (hx1 - hx0) / (2 * D), dHdz = (hz1 - hz0) / (2 * D)
  const grad = Math.hypot(dHdx, dHdz)
  if (grad > VEG.SLOPE_MAX) return null

  const elevNorm = Math.max(0, Math.min(1, elev / VEG.TREELINE))
  // micro-climate jitter so the forest is a biome-biased mix, not a monoculture (regional climate band is ~flat over one play patch).
  const vT = (rand(cellHash, K_VARIANT) - 0.5) * 0.50
  const vH = (rand(cellHash, K_SPECIESH) - 0.5) * 0.50
  const genus = speciesFor(temp, humidity, elevNorm, vT, vH)
  const species = sizeSibling(genus, rand(cellHash, K_SIZE), elevNorm)
  const scale = Math.fround(VEG.SCALE_MIN + rand(cellHash, K_SCALE) * VEG.SCALE_SPAN)
  const yaw = Math.fround(rand(cellHash, K_YAW) * Math.PI * 2)
  const windPhase = Math.fround(rand(cellHash, K_WIND) * Math.PI * 2)
  // trunks always render+collide vertical (yaw only, no tilt); normal has zero consumers, emitted as the constant up-vector.
  const tiltQuat = [0, 0, 0, 1]

  return {
    x: Math.fround(x), y: Math.fround(elev), z: Math.fround(z),
    species, scale, yaw, windPhase,
    tiltQuat, normal: VEG_UP_NORMAL,
    trunkId: trunkIdOf(x, z),
  }
}

// Shared by the atomic and incremental builders: both iterate gz-outer/gx-inner so the incremental
// cursor's output is bit-identical (same order, same values) to placementsForChunk's.
function placeVegCell(chunkX, chunkZ, gx, gz, frame, anchorField, seed, out) {
  const baseX = chunkX * VEG.CHUNK, baseZ = chunkZ * VEG.CHUNK
  const cellX = baseX + gx * VEG.CELL + VEG.CELL * 0.5
  const cellZ = baseZ + gz * VEG.CELL + VEG.CELL * 0.5
  const ix = Math.round(cellX / VEG.CELL), iz = Math.round(cellZ / VEG.CELL)
  const h = hash3(seed, ix, iz)
  const jx = (rand(h, K_JITX) * 2 - 1) * VEG.JITTER
  const jz = (rand(h, K_JITZ) * 2 - 1) * VEG.JITTER
  // pass this candidate's OWN pre-jitter (ix,iz) explicitly so classify's cellHash never collides
  // with a neighboring cell's index after jitter is applied to x/z (see classify's header).
  const p = classify(cellX + jx, cellZ + jz, frame, anchorField, undefined, ix, iz)
  if (p) out.push(p)
}

export function placementsForChunk(chunkX, chunkZ, frame, anchorField, worldSeed) {
  const out = []
  const seed = (worldSeed | 0) ^ 0x7eed
  for (let gz = 0; gz < VEG.GRID; gz++) {
    for (let gx = 0; gx < VEG.GRID; gx++) {
      placeVegCell(chunkX, chunkZ, gx, gz, frame, anchorField, seed, out)
    }
  }
  return out
}

// Incremental builder (same shape as GrassPlacement.createGrassChunkCursor): step(budgetMs) spreads one
// chunk's 64 cell classifications across placement ticks under a wall-clock budget; `list` holds the
// SAME entries in the SAME order placementsForChunk would return once `done` -- the client's veg
// streamer uses this so a chunk whose height taps miss the GPU patch cache (CPU fractal fallback,
// ~0.4ms per tap) never stalls one tick for the whole chunk. step(Infinity) completes synchronously.
export function createVegChunkCursor(chunkX, chunkZ, frame, anchorField, worldSeed, now) {
  const seed = (worldSeed | 0) ^ 0x7eed
  const clock = (typeof now === 'function') ? now : ((typeof performance !== 'undefined') ? () => performance.now() : () => 0)
  const list = []
  let gx = 0, gz = 0, done = (VEG.GRID <= 0)
  function step(budgetMs) {
    if (done) return done
    const t0 = clock()
    do {
      placeVegCell(chunkX, chunkZ, gx, gz, frame, anchorField, seed, list)
      if (++gx >= VEG.GRID) { gx = 0; if (++gz >= VEG.GRID) { done = true; break } }
    } while (clock() - t0 < budgetMs)
    return done
  }
  return { list, step, get done() { return done } }
}
