import { NoGroundHeightError } from '../../src/terrain/PlanetFrame.js'
import { isMeshSurfaceNoGround } from '../../src/terrain/TerrainMeshSurface.js'

const MESH_SOLVE_ITERS = 4
const MESH_SOLVE_TOL_M = 1e-6

// The solve is seeded with the chart's own anchor height instead of a live CPU sample: it is already
// known, it costs nothing, and the iteration is a fixed point, so the seed decides how many samples
// the solve takes rather than what it returns (measured: 26% less time over the same elevations, and
// a height that differs from the CPU-seeded one by at most 1.3e-9 m, inside the solver's own 1e-6 m
// tolerance -- scripts/exact-patch-seed-witness.mjs). The CPU sampler is still the ANSWER where the
// rendered mesh has no ground to give, so it is still asked there, and only there.
function meshElevationAtDir(frame, meshAt, fallback) {
  const radius = frame.radius
  const base = radius + frame.anchorHeight - frame.offsetY
  const E = frame.east, U = frame.up, N = frame.north
  const seed = Number.isFinite(frame.anchorHeight) ? frame.anchorHeight : 0
  return (d) => {
    const len = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2])
    if (!(len > 0)) return fallback(d)
    const de = (d[0] * E[0] + d[1] * E[1] + d[2] * E[2]) / len
    const du = (d[0] * U[0] + d[1] * U[1] + d[2] * U[2]) / len
    const dn = (d[0] * N[0] + d[1] * N[1] + d[2] * N[2]) / len
    if (!(Math.abs(du) > 1e-9)) return fallback(d)
    let r = radius + seed
    for (let k = 0; k < MESH_SOLVE_ITERS; k++) {
      const y = meshAt(r * de, r * dn)
      if (isMeshSurfaceNoGround(y)) return fallback(d)
      const next = (y + base) / du
      if (!Number.isFinite(next)) return fallback(d)
      const step = next - r
      r = next
      if (Math.abs(step) <= MESH_SOLVE_TOL_M) break
    }
    return r - radius
  }
}

export function createExactPatchFrame(frame) {
  const meshAt = typeof frame.renderMeshHeightAtLocal === 'function' ? frame.renderMeshHeightAtLocal : null
  const exact = !!meshAt || typeof frame._patchHeightOrNull === 'function'
  let missing = false
  // frame.groundHeightLocal is an ACCESSOR with a setter that installs the assigned function as
  // the whole frame's ground source, so a plain assignment on a derived object would retarget
  // every reader of the frame, not just placement. Own data properties keep the override local.
  const placementFrame = exact ? Object.create(frame) : frame
  if (exact) {
    Object.defineProperty(placementFrame, 'elevationAtDir', { value: meshAt ? meshElevationAtDir(frame, meshAt, frame.cpuElevationAtDir) : frame.elevationAtDir, writable: true, configurable: true })
    Object.defineProperty(placementFrame, 'groundHeightLocal', {
      value: (x, z) => {
        if (meshAt) {
          const y = meshAt(x, z)
          if (!isMeshSurfaceNoGround(y)) return y
        }
        if (typeof frame._patchHeightOrNull === 'function') {
          const y = frame._patchHeightOrNull(x, z)
          if (y === null) { missing = true; throw new NoGroundHeightError(x, z) }
          return y
        }
        return frame.groundHeightLocal(x, z)
      },
      writable: true, configurable: true,
    })
  }
  return {
    placementFrame,
    beginChunk() { missing = false },
    get missing() { return missing },
    prefetchChunk(centerX, centerZ) { if (typeof frame._patchPrefetch === 'function') frame._patchPrefetch(centerX, centerZ) },
  }
}
