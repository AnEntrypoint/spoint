import { NoGroundHeightError } from '../../src/terrain/PlanetFrame.js'

export function createExactPatchFrame(frame) {
  const exact = typeof frame._patchHeightOrNull === 'function'
  let missing = false
  const placementFrame = exact
    ? Object.assign(Object.create(frame), {
      groundHeightLocal: (x, z) => {
        const y = frame._patchHeightOrNull(x, z)
        if (y === null) { missing = true; throw new NoGroundHeightError(x, z) }
        return y
      },
    })
    : frame
  return {
    placementFrame,
    beginChunk() { missing = false },
    get missing() { return missing },
    prefetchChunk(centerX, centerZ) { if (typeof frame._patchPrefetch === 'function') frame._patchPrefetch(centerX, centerZ) },
  }
}
