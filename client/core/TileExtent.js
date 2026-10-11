import { guardedGroundHeight } from '/src/terrain/PlanetFrame.js'
import { commitGroundSample } from './GroundSample.js'

export function commitTileExtent(where, heightFn, sampleXZ, bounds, minY, maxY, padM) {
  const [minX, minZ, maxX, maxZ] = bounds
  if (minY <= maxY) return { empty: false, aabbMin: [minX, minY, minZ], aabbMax: [maxX, maxY, maxZ] }
  const sample = commitGroundSample(guardedGroundHeight(where, heightFn), sampleXZ[0], sampleXZ[1])
  if (sample.empty) return { empty: true, aabbMin: null, aabbMax: null }
  return { empty: false, aabbMin: [minX, sample.y - padM, minZ], aabbMax: [maxX, sample.y + padM, maxZ] }
}
