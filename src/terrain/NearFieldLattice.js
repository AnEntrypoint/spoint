
export const NEAR_FIELD_DEFAULT_GRID_STEPS = 9

export const NEAR_FIELD_DEFAULT_TILE_BUDGET = 64

export const NEAR_FIELD_FLOOR_TILES = 1

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

  const tileM = gridSteps * spacingM
  const maxLeafM = tileM * NEAR_FIELD_FLOOR_TILES
  const requestedHalfExtentM = extentM / 2
  const coverageCap = Math.max(1, Math.floor(requestedHalfExtentM / tileM))
  function floorReachLeaves(groundPerFaceMetre) {
    const gpf = positiveFinite(groundPerFaceMetre) || 1
    const outerM = (coverageCap * tileM / 2 + tileM) / MIN_GROUND_PER_FACE_METRE
    const innerM = Math.max(0, (coverageCap * tileM) / (2 * gpf) - maxLeafM)
    return { groundPerFaceMetre: gpf, outerM, innerM, outerSpanLeaves: outerM / maxLeafM, innerSpanLeaves: innerM / maxLeafM }
  }
  const floorSpanLeaves = floorReachLeaves(MIN_GROUND_PER_FACE_METRE).outerSpanLeaves

  return Object.freeze({
    spacingM,
    extentM,
    gridSteps,
    tileBudget,
    tileM,
    maxLeafM,
    requestedHalfExtentM,
    floorSpanLeaves,
    floorReachLeaves,
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
      let x0 = Math.floor((camX - half) / tileMLocal) * tileMLocal
      let y0 = Math.floor((camY - half) / tileMLocal) * tileMLocal
      if (faceHalfSpanM !== null) {
        x0 = Math.min(Math.max(x0, -faceHalfSpanM), faceHalfSpanM - perAxis * tileMLocal)
        y0 = Math.min(Math.max(y0, -faceHalfSpanM), faceHalfSpanM - perAxis * tileMLocal)
      }
      const x1 = x0 + perAxis * tileMLocal, y1 = y0 + perAxis * tileMLocal
      const EPS = 1e-6

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
