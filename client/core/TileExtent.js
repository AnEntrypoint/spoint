import { guardedGroundHeight, isNoGroundHeight } from '/src/terrain/PlanetFrame.js'

export function commitTileExtent(where, heightFn, sampleXZ, bounds, minY, maxY, padM) {
  const [minX, minZ, maxX, maxZ] = bounds
  if (minY <= maxY) return { empty: false, aabbMin: [minX, minY, minZ], aabbMax: [maxX, maxY, maxZ] }
  const groundY = guardedGroundHeight(where, heightFn)(sampleXZ[0], sampleXZ[1])
  if (isNoGroundHeight(groundY)) return { empty: true, aabbMin: null, aabbMax: null }
  return { empty: false, aabbMin: [minX, groundY - padM, minZ], aabbMax: [maxX, groundY + padM, maxZ] }
}
