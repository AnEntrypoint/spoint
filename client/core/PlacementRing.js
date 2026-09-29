import { latticeFor, ringAroundLocal, chunkKeyAtLocal, chunkCentreLocal, chunkBoundsLocal } from '/src/terrain/PlacementChart.js'

const CENTRE_CACHE_CAP = 16384
const EMPTY_RING = Object.freeze([])

export function createPlacementRing(frame, spec, ringRadiusM) {
  const lattice = (Number.isFinite(frame.radius) && frame.radius > 0) ? latticeFor(frame, spec) : null
  const centres = new Map()
  let ringKey = NaN, ring = EMPTY_RING

  function centre(key) {
    let c = centres.get(key)
    if (c) return c
    if (centres.size >= CENTRE_CACHE_CAP) centres.clear()
    c = chunkCentreLocal(lattice, frame, key, [0, 0])
    centres.set(key, c)
    return c
  }

  return {
    lattice,
    focusKeyAt(px, pz) { return lattice ? chunkKeyAtLocal(lattice, frame, px, pz) : NaN },
    ringAt(px, pz, focusKey) {
      if (!lattice) return EMPTY_RING
      if (focusKey !== ringKey) { ring = ringAroundLocal(lattice, frame, px, pz, ringRadiusM + lattice.chunkM).map(r => r.key); ringKey = focusKey }
      return ring
    },
    centre,
    distSq(key, px, pz) { const c = centre(key); const dx = c[0] - px, dz = c[1] - pz; return dx * dx + dz * dz },
    bounds(key, placements) { return chunkBoundsLocal(lattice, frame, key, placements) },
    reset() { centres.clear(); ringKey = NaN; ring = EMPTY_RING },
  }
}
