import { createChartAnchorLattice, chartAnchorCellWorstAngleDeg, CHART_ANCHORS_PER_FACE } from './chartAnchor.js'
import { CHART_REANCHOR_HYSTERESIS_DEG, WALKABLE_CHART_LIMIT_DEG } from './chartReanchorPolicy.js'
import { CLUSTER_STAY_FACTOR, CLUSTER_JOIN_FACTOR } from './clusterAssignment.js'

export const CLUSTER_DEFAULT_LINK_M = 1000
export const CLUSTER_DEFAULT_HZ = 2
export const CLUSTER_HEAP_WORLD_CEILING = 5
export const CLUSTER_DEFAULT_IDLE_GRACE_MS = 5000
export const CLUSTER_RELEVANCE_RING_CELLS = 3
const MIN_HZ = 0.5, MAX_HZ = 10

export class ClusterConfigError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`)
    this.name = 'ClusterConfigError'
    this.code = code
  }
}

export function resolveClusterConfig(spec, { radius, relevanceRadius = 200, maxWeaponRangeM = 0 }) {
  if (!spec || spec.enabled !== true) return null
  const anchorsPerFace = spec.anchorsPerFace ?? CHART_ANCHORS_PER_FACE
  const lattice = createChartAnchorLattice(radius, anchorsPerFace)
  if (!lattice) throw new ClusterConfigError('cluster-needs-planet-radius', `clusters need a positive finite planet radius, got ${radius}`)
  const cellWorstDeg = chartAnchorCellWorstAngleDeg(lattice)
  const memberRadiusM = spec.memberRadiusM ?? radius * Math.sin(cellWorstDeg * Math.PI / 180)
  const linkM = spec.linkM ?? CLUSTER_DEFAULT_LINK_M
  const ringReachM = relevanceRadius * CLUSTER_RELEVANCE_RING_CELLS
  if (linkM < ringReachM) throw new ClusterConfigError('cluster-link-below-relevance-ring', `link ${linkM} m is below the relevance ring reach ${ringReachM} m (${CLUSTER_RELEVANCE_RING_CELLS} x relevanceRadius ${relevanceRadius}), so two players that see each other could land in different worlds`)
  if (linkM < maxWeaponRangeM) throw new ClusterConfigError('cluster-link-below-weapon-range', `link ${linkM} m is below the longest weapon range ${maxWeaponRangeM} m, so a shot could target a player in another world`)
  const stayAngleDeg = Math.asin(Math.min(1, memberRadiusM * CLUSTER_STAY_FACTOR / radius)) * 180 / Math.PI
  if (stayAngleDeg + cellWorstDeg >= WALKABLE_CHART_LIMIT_DEG) throw new ClusterConfigError('cluster-radius-exceeds-walkable-chart', `stay radius ${(memberRadiusM * CLUSTER_STAY_FACTOR).toFixed(0)} m (${stayAngleDeg.toFixed(2)} deg) plus the anchor error ${cellWorstDeg.toFixed(2)} deg reaches the ${WALKABLE_CHART_LIMIT_DEG.toFixed(2)} deg walkable limit`)
  const hz = spec.hz ?? CLUSTER_DEFAULT_HZ
  if (!(hz >= MIN_HZ && hz <= MAX_HZ)) throw new ClusterConfigError('cluster-cadence-out-of-range', `hz ${hz} is outside ${MIN_HZ}..${MAX_HZ}`)
  const maxWorlds = spec.maxWorldsPerProcess ?? CLUSTER_HEAP_WORLD_CEILING
  if (!Number.isInteger(maxWorlds) || maxWorlds < 1 || maxWorlds > CLUSTER_HEAP_WORLD_CEILING) throw new ClusterConfigError('cluster-worlds-exceed-wasm-heap-budget', `maxWorldsPerProcess ${maxWorlds} is outside 1..${CLUSTER_HEAP_WORLD_CEILING}: the Jolt wasm heap is fixed at 128 MiB and a default world takes about 21 MiB`)
  return {
    radius, anchorsPerFace, lattice, cellWorstDeg, linkM, memberRadiusM, hz, maxWorlds,
    hysteresisDeg: spec.hysteresisDeg ?? CHART_REANCHOR_HYSTERESIS_DEG,
    stayFactor: CLUSTER_STAY_FACTOR, joinFactor: CLUSTER_JOIN_FACTOR,
    idleGraceMs: spec.idleGraceMs ?? CLUSTER_DEFAULT_IDLE_GRACE_MS,
  }
}
