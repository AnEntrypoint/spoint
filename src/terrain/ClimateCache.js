import { createPlacementLattice } from './PlacementLattice.js'

export let SECTOR_M = 8

const _sectorCaches = new WeakMap()

function sectorCacheFor(anchorField, frame) {
  let byField = _sectorCaches.get(frame)
  if (!byField) { byField = new WeakMap(); _sectorCaches.set(frame, byField) }
  let entry = byField.get(anchorField)
  if (!entry) {
    entry = { lattice: createPlacementLattice(frame.radius, SECTOR_M, 1), values: new Map() }
    byField.set(anchorField, entry)
  }
  return entry
}

export function createCachedAnchorField(anchorField, frame) {
  if (!anchorField || !frame) return anchorField
  const sector = sectorCacheFor(anchorField, frame)
  const lattice = sector.lattice
  const cache = sector.values

  function atDir(dir) {
    const k = lattice.chunkKeyOfDir(dir[0], dir[1], dir[2])
    let v = cache.get(k)
    if (v !== undefined) return v
    const centre = lattice.chunkCentreDir(k, [0, 0, 0])
    const sharedScratchClimate = anchorField.sampleDir ? anchorField.sampleDir(centre) : null
    v = sharedScratchClimate ? { temp: sharedScratchClimate.temp, humidity: sharedScratchClimate.humidity, erosion: sharedScratchClimate.erosion, seaBias: sharedScratchClimate.seaBias } : null
    cache.set(k, v)
    return v
  }

  return {
    climateUsesLocalXZ: false,
    climateAtLocal(x, z, dir) {
      return atDir(dir || frame.localToDir(x, z))
    },
    sampleDir(dir) {
      return anchorField.sampleDir ? anchorField.sampleDir(dir) : null
    },
    clear() { cache.clear() },
    get size() { return cache.size },
    _underlying: anchorField,
  }
}

// --- hot swap -----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapClimateCache = (next) => {
  SECTOR_M = next.SECTOR_M
  createCachedAnchorField = next.createCachedAnchorField
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapClimateCache)
