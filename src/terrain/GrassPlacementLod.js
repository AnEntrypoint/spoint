// Law-aware incremental grass placement: coarse first, refined only where the law keeps blades.
//
// src/terrain/GrassPlacement.js places a chunk whole, before anything can ask which of its blades
// the distance law will actually draw, and the law is per blade: every blade owns a rank q and is
// drawn only while the player is inside reach(q), so a chunk entering the ring at 88 m is generated
// at full blade count to keep the fraction the law admits at that distance. That is the waste this
// module removes.
//
// It is removed by giving each cell a rank-ordered slot list once and materialising a prefix of it.
// The slots are sorted by the same coin that decides whether a blade exists at all, so the set a
// distance admits is always a prefix of the set a shorter distance admits, and a chunk that the
// player approaches is extended in place: every blade already materialised keeps its index and its
// instance, and refinement costs the delta alone. A chunk the player leaves gives the suffix back,
// because the law has finished with those blades and the slot is the cost that remains; RELEASE_M
// is the dead band that keeps the two from fighting over one blade. The blade a slot produces is bit-for-bit the one
// src/terrain/GrassPlacement.js produces, so the population at any distance is a subset of the old
// one and never a different one.
import { hash3, rand, createPlacementCell, placementCellAt } from './VegPlacement.js'
import { latticeFor } from './PlacementChart.js'
import { GRASS, GRASS_DENSITY, classify, blade, grassBladeEdgeM } from './GrassPlacement.js'

const K_JITX = 20, K_JITZ = 21, K_COIN = 22

// How far a blade can sit from the cell centre it was drawn against: the clump radius in the
// tangent plane plus the horizontal part of the height offset, which tilts with the surface.
const SPREAD_M = 3
// How far the player may close before a chunk's population is re-checked. A blade is materialised
// LEAD_M before it is drawn, so the margin against a blade appearing late is LEAD_M, not zero.
const SLACK_M = 4
// How far past the reach the gate materialised it for a blade has to fall before its slot is
// given back. The gate works SPREAD_M + SLACK_M ahead of the law, so this is the dead band that
// keeps walking back over the same ground from re-extending a prefix it has just released.
const RELEASE_M = 8
// A compaction is a pass over the whole population, so a release is held until it is one worth
// taking: a sixteenth of the chunk, or 64 blades for a chunk too small to have a sixteenth.
const RELEASE_FLUSH_FRAC = 16
const RELEASE_FLUSH_MIN = 64

export const GRASS_LOD = Object.freeze({ SPREAD_M, SLACK_M, RELEASE_M })

export function grassBladeReachM(q, law) {
  return grassBladeEdgeM(q, law.fullR, law.capM) + law.leadM
}

export function createGrassChunkLod(key, frame, anchorField, worldSeed, law, now, abandoned) {
  const L = law ? {
    fullR: Number.isFinite(law.fullR) ? law.fullR : GRASS_DENSITY.FULL_R,
    capM: Number.isFinite(law.capM) ? law.capM : Infinity,
    leadM: Number.isFinite(law.leadM) ? law.leadM : GRASS_DENSITY.LEAD_M,
    spreadM: Number.isFinite(law.spreadM) ? law.spreadM : SPREAD_M,
    slackM: Number.isFinite(law.slackM) ? law.slackM : SLACK_M,
    releaseM: Number.isFinite(law.releaseM) && law.releaseM > 0 ? law.releaseM : RELEASE_M,
  } : null
  const seed = (worldSeed | 0) ^ 0x6a55
  const lattice = latticeFor(frame, GRASS)
  const dec = lattice.decodeChunk(key, [0, 0, 0])
  const cell = createPlacementCell(frame)
  const clock = (typeof now === 'function') ? now : ((typeof performance !== 'undefined') ? () => performance.now() : () => 0)
  const N = GRASS.GRID * GRASS.GRID
  const BPC = GRASS.BLADES_PER_CELL
  const cellP = new Array(N).fill(null)
  const cellOrder = new Array(N).fill(null)
  const cellCoin = new Array(N).fill(null)
  const cellN = new Uint16Array(N)
  // Where in `blades` each cell's materialised ranks live, in rank order: a release is a suffix of
  // a cell's ranking, and the array is in the order the ranks were materialised, not in cell order.
  const cellPos = new Array(N).fill(null)
  // Positions whose blades have been released and whose rows the holder has not compacted yet.
  let released = []
  let pending = null
  const slackSq = L ? L.slackM * L.slackM : 0
  const blades = []
  let gx = 0, gz = 0, done = (GRASS.GRID <= 0)
  let growAt = 0, lastFx = NaN, lastFz = NaN

  const _order = []

  function prepare(i, fx, fz) {
    const gi = i % GRASS.GRID, gj = (i - gi) / GRASS.GRID
    placementCellAt(frame, lattice, dec, gi, gj, seed, GRASS.JITTER / GRASS.CELL, K_JITX, K_JITZ, cell)
    const p = classify(frame, anchorField, cell)
    cellP[i] = p
    if (!p) return
    cellPos[i] = []
    const coins = new Float32Array(BPC)
    for (let b = 0; b < BPC; b++) coins[b] = rand(hash3(p.cellHash | 0, b + 1, 0), K_COIN)
    _order.length = 0
    for (let b = 0; b < BPC; b++) _order.push(b)
    _order.sort((a, b) => coins[a] - coins[b])
    const order = new Uint8Array(BPC), sorted = new Float32Array(BPC)
    for (let b = 0; b < BPC; b++) { const s = _order[b]; order[b] = s; sorted[b] = coins[s] }
    cellOrder[i] = order
    cellCoin[i] = sorted
    gate(i, fx, fz)
  }

  function gate(i, fx, fz) {
    const p = cellP[i]
    if (!p) return
    let n = cellN[i]
    if (n >= BPC) return
    const order = cellOrder[i], coin = cellCoin[i]
    const near = !Number.isFinite(fx) || !Number.isFinite(fz)
    // The nearest a blade of this cell can be to the focus now, less the distance the focus can
    // close before the next re-check: the law holds a blade LEAD_M past its own edge, so a blade
    // drawn anywhere in that band has to have been materialised already.
    const d = near ? 0 : Math.max(0, Math.sqrt((p.x - fx) * (p.x - fx) + (p.z - fz) * (p.z - fz)) - L.spreadM - L.slackM)
    while (n < BPC) {
      const q = p.density > 0 ? coin[n] / p.density : 1
      if (!(q < 1)) break
      if (L && !(grassBladeEdgeM(q, L.fullR, L.capM) + L.leadM >= d)) break
      const bl = blade(p, order[n])
      if (bl) { cellPos[i].push(blades.length); blades.push(bl) } else cellPos[i].push(-1)
      n++
    }
    cellN[i] = n
  }

  // The other half of the prefix: a blade the law has stopped drawing still costs the slot it was
  // materialised into, and the chunk the player has walked straight through keeps the population it
  // needed going past. Reach is monotone down the ranking, so everything the law has finished with
  // is a suffix of it and giving it back costs the suffix alone. The cut is RELEASE_M past the
  // reach the gate materialised it for, so it cannot fight the gate: closing on the cell again
  // re-extends the same ranking and produces the same blade.
  function release(i, fx, fz) {
    const p = cellP[i]
    if (!p || !L) return
    const pos = cellPos[i]
    if (!pos || pos.length === 0) return
    if (!Number.isFinite(fx) || !Number.isFinite(fz)) return
    const d = Math.max(0, Math.sqrt((p.x - fx) * (p.x - fx) + (p.z - fz) * (p.z - fz))
      - L.spreadM - L.slackM - L.releaseM)
    const coin = cellCoin[i]
    let n = cellN[i]
    while (n > 0) {
      const q = p.density > 0 ? coin[n - 1] / p.density : 1
      if (grassBladeEdgeM(q, L.fullR, L.capM) + L.leadM >= d) break
      n--
    }
    while (cellN[i] > n) {
      cellN[i]--
      const at = pos.pop()
      if (at >= 0) released.push(at)
    }
  }

  // Compaction is one pass over the array and one over the position lists, so a release is held
  // until it is worth a pass rather than paid a blade at a time.
  function flush() {
    if (released.length === 0) return null
    const n = blades.length
    if (released.length < RELEASE_FLUSH_MIN && released.length * RELEASE_FLUSH_FRAC < n) return null
    const drop = released
    released = []
    drop.sort((a, b) => a - b)
    const shift = new Int32Array(n)
    let w = 0, ri = 0
    for (let r = 0; r < n; r++) {
      if (ri < drop.length && drop[ri] === r) { ri++; shift[r] = -1; continue }
      shift[r] = w++
    }
    for (let r = 0; r < n; r++) {
      const s = shift[r]
      if (s >= 0 && s !== r) blades[s] = blades[r]
    }
    blades.length = w
    for (let i = 0; i < N; i++) {
      const pos = cellPos[i]
      if (!pos) continue
      for (let j = 0; j < pos.length; j++) if (pos[j] >= 0) pos[j] = shift[pos[j]]
    }
    return drop
  }

  function step(budgetMs, fx, fz) {
    if (done) return done
    const t0 = clock()
    do {
      prepare(gx + gz * GRASS.GRID, fx, fz)
      if (abandoned !== undefined && abandoned()) { done = true; break }
      if (++gx >= GRASS.GRID) { gx = 0; if (++gz >= GRASS.GRID) { done = true; break } }
    } while (clock() - t0 < budgetMs)
    return done
  }

  function grow(fx, fz, budgetMs) {
    if (!L || !Number.isFinite(fx) || !Number.isFinite(fz)) return 0
    if (growAt === 0 && Number.isFinite(lastFx)) {
      const dx = fx - lastFx, dz = fz - lastFz
      if (dx * dx + dz * dz < slackSq) return 0
    }
    const t0 = clock()
    const before = blades.length
    const budget = Number.isFinite(budgetMs) ? budgetMs : Infinity
    while (growAt < N) {
      const i = growAt++
      if (cellP[i]) { release(i, fx, fz); gate(i, fx, fz) }
      if (clock() - t0 >= budget) break
    }
    if (growAt >= N) { growAt = 0; lastFx = fx; lastFz = fz }
    pending = flush()
    return blades.length - before
  }

  function takeReleased() {
    const out = pending
    pending = null
    return out
  }

  return { blades, step, grow, takeReleased, get done() { return done } }
}
