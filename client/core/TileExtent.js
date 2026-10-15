import { guardedGroundHeight } from '/src/terrain/PlanetFrame.js'
import { commitGroundSample } from './GroundSample.js'

export function commitTileExtent(where, heightFn, sampleXZ, bounds, minY, maxY, padM) {
  const [minX, minZ, maxX, maxZ] = bounds
  if (minY <= maxY) return { empty: false, aabbMin: [minX, minY, minZ], aabbMax: [maxX, maxY, maxZ] }
  const sample = commitGroundSample(guardedGroundHeight(where, heightFn), sampleXZ[0], sampleXZ[1])
  if (sample.empty) return { empty: true, aabbMin: null, aabbMax: null }
  return { empty: false, aabbMin: [minX, sample.y - padM, minZ], aabbMax: [maxX, sample.y + padM, maxZ] }
}

// --- hot swap ----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapTileExtent = (next) => {
  commitTileExtent = next.commitTileExtent
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapTileExtent)
