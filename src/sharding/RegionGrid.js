export const DEFAULT_CELL_SIZE = 512
export const DEFAULT_GHOST_MARGIN = 32

export function regionIdFor(x, z, cellSize = DEFAULT_CELL_SIZE) {
  const rx = Math.floor(x / cellSize)
  const rz = Math.floor(z / cellSize)
  return `${rx},${rz}`
}

export const REGION_ID_MALFORMED = 'region-id-not-two-integers'

const REGION_ID_PATTERN = /^-?\d+,-?\d+$/

function regionIdRefusal(regionId, reason) {
  const err = new Error(`[region-grid] ${reason}: region id ${JSON.stringify(regionId)} is not "<int>,<int>"`)
  err.code = reason
  return err
}

export function parseRegionId(regionId) {
  if (typeof regionId !== 'string' || !REGION_ID_PATTERN.test(regionId)) {
    return { ok: false, reason: REGION_ID_MALFORMED, regionId }
  }
  const [rx, rz] = regionId.split(',').map(Number)
  return { ok: true, rx, rz }
}

function regionBounds(regionId, cellSize = DEFAULT_CELL_SIZE) {
  const parsed = parseRegionId(regionId)
  if (!parsed.ok) throw regionIdRefusal(regionId, parsed.reason)
  const { rx, rz } = parsed
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
