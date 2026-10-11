import { chartAnchorForDir, chartAnchorAngleDeg } from './chartAnchor.js'
import { DEFAULT_MAX_SLOPE_ANGLE_RAD } from '../physics/CharacterManager.js'

export const CHART_REANCHOR_HYSTERESIS_DEG = 0.75
export const WALKABLE_CHART_LIMIT_DEG = DEFAULT_MAX_SLOPE_ANGLE_RAD * 180 / Math.PI

export class ChartAnchorDecisionError extends Error {
  constructor(reason, message) {
    super(`${reason}: ${message}`)
    this.name = 'ChartAnchorDecisionError'
    this.reason = reason
  }
}

export class PlayersStraddlePlanetError extends Error {
  constructor() {
    super('chart reanchor players cancel to a zero centroid: they straddle the planet')
    this.name = 'PlayersStraddlePlanetError'
  }
}

function compareDirs(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

export function playerCentroidDir(dirs) {
  if (!Array.isArray(dirs)) throw new ChartAnchorDecisionError('player-directions-not-a-list', `chart reanchor needs an array of player directions, got ${dirs === null ? 'null' : typeof dirs}`)
  if (!dirs.length) return null
  const sorted = dirs.map(d => {
    if (!Array.isArray(d) || d.length < 3) throw new ChartAnchorDecisionError('player-direction-not-a-vector', `chart reanchor player direction must be a 3-component direction, got ${JSON.stringify(d) ?? typeof d}`)
    const l = Math.hypot(d[0], d[1], d[2])
    if (!(l > 0)) throw new ChartAnchorDecisionError('player-direction-has-no-length', `chart reanchor player direction has no length: ${JSON.stringify(d)}`)
    return [d[0] / l, d[1] / l, d[2] / l]
  }).sort(compareDirs)
  let x = 0, y = 0, z = 0
  for (const d of sorted) { x += d[0]; y += d[1]; z += d[2] }
  const l = Math.hypot(x, y, z)
  if (!(l > 0)) throw new PlayersStraddlePlanetError()
  return [x / l, y / l, z / l]
}

export function chartAnchorDecision({ lattice, frame, dirs, hysteresisDeg = CHART_REANCHOR_HYSTERESIS_DEG, walkableLimitDeg = WALKABLE_CHART_LIMIT_DEG }) {
  if (!lattice) throw new ChartAnchorDecisionError('decision-needs-a-lattice', 'chartAnchorDecision needs a chart anchor lattice, got none')
  const up = frame?.up
  if (!Array.isArray(up) || up.length < 3) throw new ChartAnchorDecisionError('decision-needs-a-frame-up', `chartAnchorDecision needs the current frame's up direction, got ${JSON.stringify(up) ?? typeof up}`)
  let centroidDir
  try { centroidDir = playerCentroidDir(dirs) } catch (e) {
    if (e instanceof PlayersStraddlePlanetError) return { kind: 'refusal', reason: 'players-straddle-the-planet' }
    throw e
  }
  if (!centroidDir) return { kind: 'stay', reason: 'no-players' }
  const anchorDir = chartAnchorForDir(lattice, centroidDir)
  let worstPlayerAngleDeg = 0
  for (const d of dirs) worstPlayerAngleDeg = Math.max(worstPlayerAngleDeg, chartAnchorAngleDeg({ up: anchorDir }, d))
  if (worstPlayerAngleDeg >= walkableLimitDeg) return { kind: 'refusal', reason: 'party-spread-exceeds-walkable-chart', worstPlayerAngleDeg, walkableLimitDeg }
  const sameAnchor = Math.hypot(anchorDir[0] - frame.up[0], anchorDir[1] - frame.up[1], anchorDir[2] - frame.up[2]) < 1e-9
  if (sameAnchor) return { kind: 'stay', reason: 'anchor-unchanged', gainDeg: 0 }
  const gainDeg = chartAnchorAngleDeg(frame, centroidDir) - chartAnchorAngleDeg({ up: anchorDir }, centroidDir)
  if (gainDeg < hysteresisDeg) return { kind: 'stay', reason: 'gain-below-hysteresis', gainDeg }
  return { kind: 'reanchor', anchorDir, centroidDir, gainDeg, worstPlayerAngleDeg }
}
