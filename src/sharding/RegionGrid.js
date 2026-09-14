export const DEFAULT_CELL_SIZE = 512
export const DEFAULT_GHOST_MARGIN = 32

export function regionIdFor(x, z, cellSize = DEFAULT_CELL_SIZE) {
  const rx = Math.floor(x / cellSize)
  const rz = Math.floor(z / cellSize)
  return `${rx},${rz}`
}

export function regionCoordsFor(x, z, cellSize = DEFAULT_CELL_SIZE) {
  return { rx: Math.floor(x / cellSize), rz: Math.floor(z / cellSize) }
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

export function neighborRegionIds(regionId) {
  const { rx, rz } = parseRegionId(regionId)
  const out = []
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue
      out.push(regionIdFromCoords(rx + dx, rz + dz))
    }
  }
  return out
}

export function distanceToRegionEdge(x, z, regionId, cellSize = DEFAULT_CELL_SIZE) {
  const b = regionBounds(regionId, cellSize)
  const dx = Math.max(b.minX - x, 0, x - b.maxX)
  const dz = Math.max(b.minZ - z, 0, z - b.maxZ)
  if (dx === 0 && dz === 0) {
    return -Math.min(x - b.minX, b.maxX - x, z - b.minZ, b.maxZ - z)
  }
  return Math.sqrt(dx * dx + dz * dz)
}

export function isInGhostRange(x, z, regionId, cellSize = DEFAULT_CELL_SIZE, ghostMargin = DEFAULT_GHOST_MARGIN) {
  const gb = regionBoundsWithGhost(regionId, cellSize, ghostMargin)
  return x >= gb.minX && x <= gb.maxX && z >= gb.minZ && z <= gb.maxZ
}

export function authoritativeRegionFor(x, z, cellSize = DEFAULT_CELL_SIZE) {
  return regionIdFor(x, z, cellSize)
}

export function checkBoundaryCrossing(x, z, prevRegionId, cellSize = DEFAULT_CELL_SIZE) {
  const cur = authoritativeRegionFor(x, z, cellSize)
  return cur === prevRegionId ? null : cur
}
