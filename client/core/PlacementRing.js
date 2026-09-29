import { latticeFor, ringAroundLocal, chunkKeyAtLocal, chunkCentreLocal, chunkBoundsLocal } from '/src/terrain/PlacementChart.js'

const CENTRE_CACHE_CAP = 16384
const EMPTY_RING = Object.freeze([])

export function createPlacementRing(frame, spec, ringRadiusM) {
  const lattice = (Number.isFinite(frame.radius) && frame.radius > 0) ? latticeFor(frame, spec) : null
  const centres = new Map()
  let ringKey = NaN, ring = EMPTY_RING, anchorX = NaN, anchorZ = NaN

  function centre(key) {
    let c = centres.get(key)
    if (c) return c
    if (centres.size >= CENTRE_CACHE_CAP) centres.clear()
    c = chunkCentreLocal(lattice, frame, key, [0, 0])
    centres.set(key, c)
    return c
  }

  function keysAround(focusKey) {
    const a = centre(focusKey)
    return ringAroundLocal(lattice, frame, a[0], a[1], ringRadiusM + lattice.chunkM).map(r => r.key)
  }

  function distSqFrom(key, ax, az) { const c = centre(key); const dx = c[0] - ax, dz = c[1] - az; return dx * dx + dz * dz }

  return {
    lattice,
    focusKeyAt(px, pz) { return lattice ? chunkKeyAtLocal(lattice, frame, px, pz) : NaN },
    ringAt(px, pz, focusKey) {
      if (!lattice) return EMPTY_RING
      if (focusKey !== ringKey) {
        ring = keysAround(focusKey); ringKey = focusKey
        const a = centre(focusKey); anchorX = a[0]; anchorZ = a[1]
      }
      return ring
    },
    centre,
    distSqFromFocus(key) { return distSqFrom(key, anchorX, anchorZ) },
    bounds(key, placements) { return chunkBoundsLocal(lattice, frame, key, placements) },
    reset() { centres.clear(); ringKey = NaN; ring = EMPTY_RING; anchorX = NaN; anchorZ = NaN },
    streamState(loaded, deferred, focus, ringRadiusSq, dropRadiusSq) {
      const [px, pz] = focus
      if (!lattice || !Number.isFinite(px) || !Number.isFinite(pz)) return { focus: [px, pz], expected: 0, loaded: loaded.size, missing: 0, deferred: deferred.size, stale: 0, missingKeys: [] }
      const focusKey = chunkKeyAtLocal(lattice, frame, px, pz)
      const [ax, az] = centre(focusKey)
      const expected = keysAround(focusKey).filter(key => distSqFrom(key, ax, az) <= ringRadiusSq)
      const missing = expected.filter(key => !loaded.has(key) && !deferred.has(key))
      let stale = 0
      for (const key of loaded.keys()) if (distSqFrom(key, ax, az) > dropRadiusSq) stale++
      return { focus: [px, pz], focusKey, anchor: [ax, az], expected: expected.length, loaded: loaded.size, missing: missing.length, deferred: deferred.size, stale, missingKeys: missing.slice(0, 8) }
    },
  }
}
