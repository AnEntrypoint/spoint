export const DEFAULT_CELL_SIZE = 512
export const DEFAULT_GHOST_MARGIN = 32

export function regionIdFor(x, z, cellSize = DEFAULT_CELL_SIZE) {
  const rx = Math.floor(x / cellSize)
  const rz = Math.floor(z / cellSize)
  return `${rx},${rz}`
}

export function regionIdFromCoords(rx, rz) {
  return `${rx},${rz}`
}

export function parseRegionId(regionId) {
  const [rx, rz] = regionId.split(',').map(Number)
  return { rx, rz }
}

export function regionBounds(regionId, cellSize = DEFAULT_CELL_SIZE) {
  const { rx, rz } = parseRegionId(regionId)
  return {
    minX: rx * cellSize, maxX: (rx + 1) * cellSize,
    minZ: rz * cellSize, maxZ: (rz + 1) * cellSize
  }
}

export function regionBoundsWithGhost(regionId, cellSize = DEFAULT_CELL_SIZE, ghostMargin = DEFAULT_GHOST_MARGIN) {
  const b = regionBounds(regionId, cellSize)
  return { minX: b.minX - ghostMargin, maxX: b.maxX + ghostMargin, minZ: b.minZ - ghostMargin, maxZ: b.maxZ + ghostMargin }
}

export function authoritativeRegionFor(x, z, cellSize = DEFAULT_CELL_SIZE) {
  return regionIdFor(x, z, cellSize)
}
