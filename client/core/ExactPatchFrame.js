import { NoGroundHeightError } from '../../src/terrain/PlanetFrame.js'
import { isMeshSurfaceNoGround, renderMeshHeightAt } from '../../src/terrain/TerrainMeshSurface.js'

const MESH_SOLVE_ITERS = 4
const MESH_SOLVE_TOL_M = 1e-6

// The solve keeps two seeds and no distance threshold. It starts from the chart's own anchor
// height, which is already known and costs nothing, and it is ANSWERED from that start only where
// the iteration reached its own tolerance. Where it did not, the answer would be wherever the
// iteration ran out of budget -- a function of the seed rather than of the surface -- so the CPU
// sampler is paid there and the solve runs from its elevation, exactly as it did before c822a7b4.
//
// The budget is what makes this necessary rather than theoretical: inside every placement ring the
// anchor-seeded solve converges and agrees with the CPU-seeded one to 1e-9 m, but past ~200 m the
// rendered mesh is coarse enough that 4 iterations no longer reach it, and the unguarded answer
// there moves vegetation and rock placement by up to 1.77 m
// (scripts/exact-patch-seed-radius-witness.mjs). Convergence is a property of the answer, so it
// holds or fails per direction; a radius threshold would not.
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
    let converged = false
    for (let k = 0; k < MESH_SOLVE_ITERS; k++) {
      const y = meshAt(r * de, r * dn)
      if (isMeshSurfaceNoGround(y)) break
      const next = (y + base) / du
      if (!Number.isFinite(next)) break
      const step = next - r
      r = next
      if (Math.abs(step) <= MESH_SOLVE_TOL_M) { converged = true; break }
    }
    if (converged) return r - radius
    const h0 = fallback(d)
    if (!Number.isFinite(h0)) return h0
    r = radius + h0
    for (let k = 0; k < MESH_SOLVE_ITERS; k++) {
      const y = meshAt(r * de, r * dn)
      if (isMeshSurfaceNoGround(y)) return h0
      const next = (y + base) / du
      if (!Number.isFinite(next)) return h0
      const step = next - r
      r = next
      if (Math.abs(step) <= MESH_SOLVE_TOL_M) break
    }
    return r - radius
  }
}

export function createExactPatchFrame(frame) {
  let missing = false
  // The drawn-mesh surface is resolved per call, never captured: it is the frame's own port and the
  // port is re-attached whenever the planet is rebuilt, so whatever this frame was built against is
  // not necessarily what is drawn now. The resolved FUNCTION is memoised, not its answer, so the
  // elevation solver is rebuilt only when the frame actually points at a different surface -- and
  // where no surface is attached at all the frame's own sampler is read live, because that one is
  // swapped too (a ground-source registration replaces frame.elevationAtDir).
  let meshAt = null
  let meshElev = null
  const meshAtNow = () => {
    const at = renderMeshHeightAt(frame)
    if (at !== meshAt) {
      meshAt = at
      meshElev = at === null ? null : meshElevationAtDir(frame, at, frame.cpuElevationAtDir)
    }
    return at
  }
  // frame.groundHeightLocal is an ACCESSOR with a setter that installs the assigned function as
  // the whole frame's ground source, so a plain assignment on a derived object would retarget
  // every reader of the frame, not just placement. Own data properties keep the override local.
  const placementFrame = Object.create(frame)
  Object.defineProperty(placementFrame, 'elevationAtDir', {
    value: (d) => {
      const at = meshAtNow()
      return at === null ? frame.elevationAtDir(d) : meshElev(d)
    }, writable: true, configurable: true,
  })
  Object.defineProperty(placementFrame, 'groundHeightLocal', {
    value: (x, z) => {
      const at = meshAtNow()
      if (at !== null) {
        const y = at(x, z)
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
  return {
    placementFrame,
    beginChunk() { missing = false },
    get missing() { return missing },
    prefetchChunk(centerX, centerZ) { if (typeof frame._patchPrefetch === 'function') frame._patchPrefetch(centerX, centerZ) },
  }
}
