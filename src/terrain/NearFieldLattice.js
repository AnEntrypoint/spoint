// The near-field lattice: ONE regular grid at the collider's spacing, from which the rendered near
// band is built. The collider already builds that spacing -- see src/shared/colliderLattice.js --
// so the ground the player walks on and the ground the player sees are two draws of one density
// instead of two independent samplings of one height field.
//
// The band is PLAYER-CENTRED and its extent is the collider's own field, not a subdivision of
// whichever quadtree leaf the player happens to be standing in. That is what makes the band the same
// ground at every quality tier: a band derived by subdividing the host leaf can only cover
// floor(budget / divisions^2) leaves, so at the tier where the host leaf is one whole budget of
// tiles it covers exactly ONE leaf -- a ~62 m island of collider-resolution ground in a field of
// leaves whose spacing is whatever maxLevel happens to allow. Deciding the band's extent from the
// collider instead of from the leaf is the whole difference, and it is why extentM is required here
// rather than defaulted.
//
// It is a PLAN over the renderer's own shared patch geometry, not a new coordinate system and not a
// second mesh: a tile is drawn exactly as a quadtree leaf is drawn -- same instances, same vertex
// stage, same skirt -- so this introduces no second material and no second shader path.
//
// Nothing here knows about WebGPU, quads or shaders, so scripts can measure it with no GPU at all.

export const NEAR_FIELD_DEFAULT_GRID_STEPS = 9

// How many tiles one dropped leaf may cost. The quadtree's near-field floor is one leaf of
// tileM * floor(sqrt(tileBudget)): the largest leaf the band can still cover, so a leaf bigger than
// it is never dropped and the band steps around it instead. This is a bound on the cost of REPLACING
// one leaf, never a bound on how much ground the band covers -- coverage is the collider's extent,
// and a band that cannot afford the collider's whole extent reports the shortfall instead of
// silently covering less.
export const NEAR_FIELD_DEFAULT_TILE_BUDGET = 64

// One tile wide: the widest leaf the band's rim may abut is a leaf the SAME size as a tile, so the
// ground past the rim is drawn at the band's own spacing instead of one quadtree level coarser. The
// rim step is bounded by the COARSER of the two surfaces, so a rim meeting 2.00 m ground against
// 1.00 m tiles is bounded by the 2.00 m side and no property of the band can shrink it -- that is
// what measured 0.11113 m at every tier (scripts/nearfield-lod-lattice-witness.mjs, perimeterJump,
// max over ~1004 samples of the footprint perimeter, identical at all 8 tiers because the band and
// the floor-refined ground past it are identical at all 8 tiers). At one tile wide the coarse side IS
// the band, so the step collapses onto the band's own faceting.
export const NEAR_FIELD_FLOOR_TILES = 1

// The cube-sphere map is not conformal: one face-local metre is 0.780 m of ground along u and 0.617
// along v at the tps-game anchor, and it drifts with position on the face. The floor is a length in
// FACE-LOCAL metres while the band's extent is metres of GROUND, so the floor's reach is the band's
// extent divided by the SMALLEST ground-per-face-metre the map can show, or the floor stops short of
// the rim on the part of the face where the map stretches most.
export const MIN_GROUND_PER_FACE_METRE = 0.6

function positiveFinite(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

export function createNearFieldLattice(opts = {}) {
  const spacingM = positiveFinite(opts.spacingM)
  if (spacingM === null) throw new RangeError(`near-field lattice: spacingM must be a positive finite number of metres, got ${String(opts.spacingM)}: the lattice is the collider's own spacing, so a lattice that does not name one is not the collider's lattice`)
  const extentM = positiveFinite(opts.extentM)
  if (extentM === null) throw new RangeError(`near-field lattice: extentM must be a positive finite number of metres, got ${String(opts.extentM)}: the band is the collider's own field, so a lattice that does not name one is not the collider's lattice, and defaulting it is what lets the band silently cover one leaf instead of the ground around the player`)
  const gridSteps = Number.isInteger(opts.gridSteps) && opts.gridSteps >= 2 ? opts.gridSteps : NEAR_FIELD_DEFAULT_GRID_STEPS
  const tileBudget = Number.isInteger(opts.tileBudget) && opts.tileBudget >= 1 ? opts.tileBudget : NEAR_FIELD_DEFAULT_TILE_BUDGET
  const faceHalfSpanM = positiveFinite(opts.faceHalfSpanM)

  // A tile is gridSteps intervals of the collider's spacing, so a tile's step IS the collider's
  // step -- the whole claim: the near band can never be coarser than the surface it replaces.
  const tileM = gridSteps * spacingM
  // The quadtree must offer a leaf the band can cover, or there is no band. That is a floor on the
  // quadtree's near-field subdivision, derived here in metres and read by Quadtree, so the two
  // cannot disagree about how fine the near band's leaves are.
  const maxLeafM = tileM * NEAR_FIELD_FLOOR_TILES
  const requestedHalfExtentM = extentM / 2
  // How wide the band can get: a whole number of tiles, capped so a step of distance tessellation
  // cannot drag the rim outward with the LOD and migrate the ridge when quality is shed.
  const coverageCap = Math.max(1, Math.floor(requestedHalfExtentM / tileM))
  // The floor has to hold across the whole band AND one cell past it: a rim whose other side is
  // ground the floor never reached is a rim that meets the far field after all. The band's footprint
  // is a square, so its corner is sqrt(2) half-extents out, and the floor is a radius -- the reach is
  // the corner, not the edge. measured step at the tps-game anchor with this floor: 1.34 m of ground
  // per leaf against the band's 1.00 m.
  const floorReachM = ((coverageCap * tileM) / 2) * Math.SQRT2 / MIN_GROUND_PER_FACE_METRE + maxLeafM
  const floorSpanLeaves = floorReachM / maxLeafM

  return Object.freeze({
    spacingM,
    extentM,
    gridSteps,
    tileBudget,
    tileM,
    maxLeafM,
    requestedHalfExtentM,
    floorSpanLeaves,
    // leaves: the quadtree's leaves, each { ox, oy, l }. camera is the player in the same face-local
    // metres. instanceBudget caps the band's tile count at the number of instances the terrain
    // payload it joins already spends, so the band can never cost more than the ground it replaces
    // is worth at this tier; when that is less than the collider's extent the shortfall is reported.
    // groundPerFaceMetre: how many metres of GROUND one face-local metre is at the band, from the
    // cube-sphere map's own metric. spacingM and extentM are metres of ground -- they are the
    // collider's -- but the tile grid is laid out in face-local metres, so without this the band
    // draws at 0.698 m where the collider is 1.00 m and covers 89 m of ground where the collider's
    // field is 256 m: the same number of tiles, a third of the ground, and a spacing that drifts
    // with where on the face the player stands. Measured in the shipped client, TOD pinned.
    plan(leaves, camera, gridStepsOverride, instanceBudget, groundPerFaceMetre) {
      const gs = Number.isInteger(gridStepsOverride) && gridStepsOverride >= 2 ? gridStepsOverride : gridSteps
      const gpf = positiveFinite(groundPerFaceMetre) || 1
      const tileMLocal = tileM / gpf
      const halfExtentLocal = requestedHalfExtentM / gpf
      const empty = (extra) => ({
        tiles: [], drop: [], tileM: tileMLocal, stepM: spacingM, tileCount: 0, coveredLeafCount: 0, vertexCount: 0,
        groundPerFaceMetre: gpf, requestedHalfExtentM, coveredHalfExtentM: 0, coveredHalfExtentGroundM: 0,
        shortfallM: requestedHalfExtentM, straddlingLeafCount: 0, suppressedTiles: 0, tilesPerAxis: 0, ...extra,
      })
      if (!Array.isArray(leaves) || !leaves.length) return empty({})
      const camX = camera ? camera[0] : NaN, camY = camera ? camera[1] : NaN
      if (!Number.isFinite(camX) || !Number.isFinite(camY)) return empty({})

      const budget = Number.isInteger(instanceBudget) && instanceBudget >= 1 ? instanceBudget : leaves.length
      const wanted = Math.ceil((2 * halfExtentLocal) / tileMLocal)
      const perAxis = Math.max(1, Math.min(Math.floor(Math.sqrt(budget)), wanted, coverageCap))
      const half = (perAxis * tileMLocal) / 2
      // The band is snapped to the collider's own grid so its vertices do not swim with the camera:
      // moving by less than a tile moves nothing, moving by a tile moves the band by a whole tile.
      let x0 = Math.floor((camX - half) / tileMLocal) * tileMLocal
      let y0 = Math.floor((camY - half) / tileMLocal) * tileMLocal
      if (faceHalfSpanM !== null) {
        x0 = Math.min(Math.max(x0, -faceHalfSpanM), faceHalfSpanM - perAxis * tileMLocal)
        y0 = Math.min(Math.max(y0, -faceHalfSpanM), faceHalfSpanM - perAxis * tileMLocal)
      }
      const x1 = x0 + perAxis * tileMLocal, y1 = y0 + perAxis * tileMLocal
      const EPS = 1e-6

      // A leaf is dropped only when the band covers it WHOLE; a leaf straddling the rim is kept, and
      // every tile inside a kept leaf is suppressed. That is what keeps the band free of both a hole
      // (a dropped leaf nothing fills) and a doubled surface (a kept leaf the band also draws).
      const drop = [], straddle = []
      for (const q of leaves) {
        const qx1 = q.ox + q.l, qy1 = q.oy + q.l
        const overlaps = qx1 > x0 + EPS && qy1 > y0 + EPS && q.ox < x1 - EPS && q.oy < y1 - EPS
        if (!overlaps) continue
        if (q.ox >= x0 - EPS && q.oy >= y0 - EPS && qx1 <= x1 + EPS && qy1 <= y1 + EPS) drop.push(q)
        else straddle.push(q)
      }

      const tiles = []
      let suppressed = 0
      for (let j = 0; j < perAxis; j++) {
        for (let i = 0; i < perAxis; i++) {
          const ox = x0 + i * tileMLocal, oy = y0 + j * tileMLocal
          let covered = false
          for (const q of straddle) {
            if (ox >= q.ox - EPS && oy >= q.oy - EPS && ox + tileMLocal <= q.ox + q.l + EPS && oy + tileMLocal <= q.oy + q.l + EPS) { covered = true; break }
          }
          if (covered) { suppressed++; continue }
          tiles.push({ ox, oy, l: tileMLocal, level: 0 })
        }
      }
      return {
        tiles, drop, tileM: tileMLocal, stepM: spacingM, tileCount: tiles.length, coveredLeafCount: drop.length,
        vertexCount: tiles.length * (gs + 3) * (gs + 3),
        groundPerFaceMetre: gpf, requestedHalfExtentM, coveredHalfExtentM: half,
        coveredHalfExtentGroundM: half * gpf, shortfallM: Math.max(0, requestedHalfExtentM - half * gpf),
        straddlingLeafCount: straddle.length, suppressedTiles: suppressed, tilesPerAxis: perAxis,
        instanceBudget: budget,
        refused: null,
      }
    },
  })
}
