// The near-field lattice: ONE regular grid at the collider's spacing, from which the rendered near
// band is built. The collider already builds that spacing -- see src/shared/colliderLattice.js --
// so the ground the player walks on and the ground the player sees are two draws of one density
// instead of two independent samplings of one height field.
//
// It is a PLAN over the quadtree's own leaf grid, not a new coordinate system. A tile is a whole
// fraction of a quadtree leaf, so the lattice replaces WHOLE leaves: no leaf is ever half covered,
// which is what keeps the change free of both a hole (a dropped leaf the lattice does not fill) and
// a doubled surface (a kept leaf the lattice also draws). The renderer's shared patch geometry draws
// a tile exactly as it draws a leaf -- same instances, same vertex stage, same skirt -- so this
// introduces no second mesh, no second material and no second shader path.
//
// Nothing here knows about WebGPU, quads or shaders, so scripts can measure it with no GPU at all.

export const NEAR_FIELD_DEFAULT_GRID_STEPS = 9

// The near band may spend at most this many tiles of the shared grid. It is a budget on the one
// band the renderer is not allowed to govern, not a quality dial: the lattice never coarsens to fit
// it, it covers fewer leaves.
export const NEAR_FIELD_DEFAULT_TILE_BUDGET = 64

function positiveFinite(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

export function createNearFieldLattice(opts = {}) {
  const spacingM = positiveFinite(opts.spacingM)
  if (spacingM === null) throw new RangeError(`near-field lattice: spacingM must be a positive finite number of metres, got ${String(opts.spacingM)}: the lattice is the collider's own spacing, so a lattice that does not name one is not the collider's lattice`)
  const gridSteps = Number.isInteger(opts.gridSteps) && opts.gridSteps >= 2 ? opts.gridSteps : NEAR_FIELD_DEFAULT_GRID_STEPS
  const tileBudget = Number.isInteger(opts.tileBudget) && opts.tileBudget >= 1 ? opts.tileBudget : NEAR_FIELD_DEFAULT_TILE_BUDGET

  // A leaf is split into c x c tiles, each of gridSteps intervals, so a tile's step is
  // leafM / (c * gridSteps). c is the smallest count whose step is at or finer than the collider's,
  // which is the whole claim: the near band can never be coarser than the surface it replaces. A
  // leaf the budget cannot tile at that c is not covered at all, and the quadtree keeps it, because
  // drawing a coarser lattice over ground would be the decimation this exists to remove.
  function divisionsFor(leafM, gs = gridSteps) {
    if (!Number.isFinite(leafM) || leafM <= 0) return null
    const c = Math.max(1, Math.ceil(leafM / (gs * spacingM)))
    return { c, tileM: leafM / c, stepM: leafM / (c * gs) }
  }

  // The quadtree must offer a leaf the budget can tile at collider res, or there is no lattice. That
  // is a floor on the quadtree's near-field subdivision, derived here in metres and read by Quadtree,
  // so the two cannot disagree about how fine the near band's leaves are.
  const maxLeafM = gridSteps * spacingM * Math.floor(Math.sqrt(tileBudget))

  return Object.freeze({
    spacingM,
    gridSteps,
    tileBudget,
    maxLeafM,
    divisionsFor,
    // leaves: the quadtree's leaves, each { ox, oy, l }. The camera's leaf sets the tile size; the
    // lattice takes the nearest leaves of exactly that size, up to the budget, and returns both the
    // tiles to draw and the leaves to drop.
    plan(leaves, camera, gridStepsOverride) {
      const gs = Number.isInteger(gridStepsOverride) && gridStepsOverride >= 2 ? gridStepsOverride : gridSteps
      const empty = (extra) => ({ tiles: [], drop: [], c: 0, tileM: 0, stepM: 0, leafM: 0, coveredLeafCount: 0, vertexCount: 0, ...extra })
      if (!Array.isArray(leaves) || !leaves.length) return empty({})
      let host = null, hostD = Infinity
      for (const q of leaves) {
        const cx = q.ox + q.l * 0.5, cy = q.oy + q.l * 0.5
        const d = Math.max(Math.abs(camera[0] - cx) - q.l * 0.5, Math.abs(camera[1] - cy) - q.l * 0.5, 0)
        if (d < hostD) { hostD = d; host = q }
      }
      if (!host) return empty({})
      const div = divisionsFor(host.l, gs)
      if (!div || div.c * div.c > tileBudget) {
        return empty({ c: div ? div.c : 0, tileM: div ? div.tileM : 0, stepM: div ? div.stepM : 0, leafM: host.l, refused: `a ${host.l.toFixed(1)}m leaf needs ${div ? div.c * div.c : '?'} tiles to reach ${spacingM}m, over the ${tileBudget} tile budget` })
      }
      const same = []
      for (const q of leaves) {
        if (Math.abs(q.l - host.l) > 1e-6) continue
        const cx = q.ox + q.l * 0.5, cy = q.oy + q.l * 0.5
        const d = Math.max(Math.abs(camera[0] - cx) - q.l * 0.5, Math.abs(camera[1] - cy) - q.l * 0.5, 0)
        same.push({ q, d })
      }
      same.sort((a, b) => a.d - b.d)
      const n = Math.max(0, Math.min(same.length, Math.floor(tileBudget / (div.c * div.c))))
      const drop = []
      const tiles = []
      for (let i = 0; i < n; i++) {
        const q = same[i].q
        drop.push(q)
        for (let j = 0; j < div.c; j++) for (let k = 0; k < div.c; k++) tiles.push({ ox: q.ox + k * div.tileM, oy: q.oy + j * div.tileM, l: div.tileM, level: 0 })
      }
      return {
        tiles, drop, c: div.c, tileM: div.tileM, stepM: div.stepM, leafM: host.l,
        coveredLeafCount: n,
        vertexCount: tiles.length * (gs + 3) * (gs + 3),
        sameSizeLeafCount: same.length,
      }
    },
  })
}
