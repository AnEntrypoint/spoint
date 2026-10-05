import { chartAnchorForDir, chartAnchorAngleDeg } from './chartAnchor.js'

export const CHART_REANCHOR_HYSTERESIS_DEG = 0.75

function compareDirs(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

export function playerCentroidDir(dirs) {
  if (!dirs.length) return null
  const sorted = dirs.map(d => {
    const l = Math.hypot(d[0], d[1], d[2])
    if (!(l > 0)) throw new Error(`chart reanchor player direction has no length: ${JSON.stringify(d)}`)
    return [d[0] / l, d[1] / l, d[2] / l]
  }).sort(compareDirs)
  let x = 0, y = 0, z = 0
  for (const d of sorted) { x += d[0]; y += d[1]; z += d[2] }
  const l = Math.hypot(x, y, z)
  if (!(l > 0)) throw new Error('chart reanchor players cancel to a zero centroid: they straddle the planet')
  return [x / l, y / l, z / l]
}

export function chartAnchorDecision({ lattice, frame, dirs, hysteresisDeg = CHART_REANCHOR_HYSTERESIS_DEG }) {
  const centroidDir = playerCentroidDir(dirs)
  if (!centroidDir) return null
  const anchorDir = chartAnchorForDir(lattice, centroidDir)
  const sameAnchor = Math.hypot(anchorDir[0] - frame.up[0], anchorDir[1] - frame.up[1], anchorDir[2] - frame.up[2]) < 1e-9
  if (sameAnchor) return null
  const gainDeg = chartAnchorAngleDeg(frame, centroidDir) - chartAnchorAngleDeg({ up: anchorDir }, centroidDir)
  if (gainDeg < hysteresisDeg) return null
  let worstPlayerAngleDeg = 0
  for (const d of dirs) worstPlayerAngleDeg = Math.max(worstPlayerAngleDeg, chartAnchorAngleDeg({ up: anchorDir }, d))
  return { anchorDir, centroidDir, gainDeg, worstPlayerAngleDeg }
}
