// Region-shard grid math: partitions the X/Z ground plane into square cells, one region-shard worker
// per cell. Pure functions, no I/O -- used identically by the router (to pick which worker owns a
// player) and by each region worker (to know its own AABB + detect a ghost-margin/boundary crossing).
//
// Region id is a packed "rx,rz" string (not a Cantor/interleave int) -- negative coordinates are
// expected (the world origin sits at a shard boundary corner, not a grid edge), and the string form
// is trivially debuggable in logs/IPC payloads without a decode step.

// Default cell size in world units (matches typical relevanceRadius-scale worlds -- see
// stageLoader.js's relevanceRadius default of 200; a 512m cell keeps several relevance-radii of
// margin inside one shard under normal play, so boundary crossings are a real but not constant event).
export const DEFAULT_CELL_SIZE = 512
// Ghost margin: a belt of `GHOST_MARGIN` world units on each side of a region boundary in which an
// entity is considered "in both regions" for handoff purposes -- the receiving region is told about
// the crossing (and can prewarm/preload) before the authoritative handoff actually completes, and the
// losing region keeps ticking the player until the crossing is fully committed so there's no frame
// where neither shard owns them.
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

// World-space AABB (min/max X/Z, y unbounded) owned by a region, EXCLUDING the ghost margin.
export function regionBounds(regionId, cellSize = DEFAULT_CELL_SIZE) {
  const { rx, rz } = parseRegionId(regionId)
  return {
    minX: rx * cellSize, maxX: (rx + 1) * cellSize,
    minZ: rz * cellSize, maxZ: (rz + 1) * cellSize
  }
}

// AABB INCLUDING the ghost margin -- the region a worker actually simulates a margin-belt of, so
// entities just across a border still collide/interact correctly with this region's own entities
// during the handoff window instead of popping in/out at the hard boundary.
export function regionBoundsWithGhost(regionId, cellSize = DEFAULT_CELL_SIZE, ghostMargin = DEFAULT_GHOST_MARGIN) {
  const b = regionBounds(regionId, cellSize)
  return { minX: b.minX - ghostMargin, maxX: b.maxX + ghostMargin, minZ: b.minZ - ghostMargin, maxZ: b.maxZ + ghostMargin }
}

// The 8 neighboring region ids (Chebyshev-adjacent) -- these are the only shards a ghost-margin
// crossing can ever hand off to, since the margin is always smaller than one full cell.
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

// Distance (world units) from (x,z) to the nearest edge of `regionId`'s core bounds. Negative means
// inside the region (magnitude = distance to nearest edge from inside); positive means outside.
export function distanceToRegionEdge(x, z, regionId, cellSize = DEFAULT_CELL_SIZE) {
  const b = regionBounds(regionId, cellSize)
  const dx = Math.max(b.minX - x, 0, x - b.maxX)
  const dz = Math.max(b.minZ - z, 0, z - b.maxZ)
  if (dx === 0 && dz === 0) {
    // inside: distance to nearest edge (negative-of-outside-distance convention)
    return -Math.min(x - b.minX, b.maxX - x, z - b.minZ, b.maxZ - z)
  }
  return Math.sqrt(dx * dx + dz * dz)
}

// True while (x,z) sits inside `regionId`'s core bounds, expanded by `ghostMargin` on the OUTWARD
// side only -- i.e. true for the core region AND its ghost belt, false once fully past the belt.
export function isInGhostRange(x, z, regionId, cellSize = DEFAULT_CELL_SIZE, ghostMargin = DEFAULT_GHOST_MARGIN) {
  const gb = regionBoundsWithGhost(regionId, cellSize, ghostMargin)
  return x >= gb.minX && x <= gb.maxX && z >= gb.minZ && z <= gb.maxZ
}

// The authoritative region for a raw (x,z) position -- always the tight (non-ghost) cell, i.e. every
// point on the plane belongs to EXACTLY one authoritative region regardless of ghost margins.
export function authoritativeRegionFor(x, z, cellSize = DEFAULT_CELL_SIZE) {
  return regionIdFor(x, z, cellSize)
}

// Given a player's previous authoritative region and current position, decide whether a handoff must
// begin. Returns null if no handoff is needed (still owned by `prevRegionId`), else the target region
// id the player has crossed INTO (authoritative-region-changed). Call once per tick per player from
// the OWNING region worker.
export function checkBoundaryCrossing(x, z, prevRegionId, cellSize = DEFAULT_CELL_SIZE) {
  const cur = authoritativeRegionFor(x, z, cellSize)
  return cur === prevRegionId ? null : cur
}
