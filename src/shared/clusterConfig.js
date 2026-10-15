import { createChartAnchorLattice, chartAnchorCellWorstAngleDeg, CHART_ANCHORS_PER_FACE } from './chartAnchor.js'
import { CHART_REANCHOR_HYSTERESIS_DEG, WALKABLE_CHART_LIMIT_DEG } from './chartReanchorPolicy.js'
import { CLUSTER_STAY_FACTOR, CLUSTER_JOIN_FACTOR } from './clusterAssignment.js'
import { DEFAULT_JOLT_LIMITS, joltReservationBytes } from '../physics/joltLimits.js'
import { DEFAULT_COMBAT } from '../behaviours/combat.js'

export let CLUSTER_DEFAULT_LINK_M = 1000
export let CLUSTER_DEFAULT_HZ = 2.05
export let JOLT_WASM_HEAP_BYTES = 134217728
export let JOLT_WASM_RESIDENT_BYTES = 1157976
export let JOLT_MIRROR_MARGINAL_BYTES = 11278387
export let CLUSTER_HEAP_MIRROR_RESERVE = 2
export let CLUSTER_SERVER_JOLT_LIMITS = Object.freeze({ maxBodies: 8192, maxBodyPairs: 8192, maxContactConstraints: 2048 })
export let JOLT_WORLD_MARGINAL_AT_DEFAULT_LIMITS_BYTES = 20238432
export let JOLT_WORLD_MARGINAL_BYTES = JOLT_WORLD_MARGINAL_AT_DEFAULT_LIMITS_BYTES
  - joltReservationBytes(DEFAULT_JOLT_LIMITS)
  + joltReservationBytes(CLUSTER_SERVER_JOLT_LIMITS)
export let CLUSTER_HEAP_RESERVE_FRACTION = 0.1
export let CLUSTER_HEAP_WORLD_CEILING = Math.floor(
  (JOLT_WASM_HEAP_BYTES - JOLT_WASM_RESIDENT_BYTES - CLUSTER_HEAP_MIRROR_RESERVE * JOLT_MIRROR_MARGINAL_BYTES)
  / (JOLT_WORLD_MARGINAL_BYTES * (1 + CLUSTER_HEAP_RESERVE_FRACTION)),
)
export let CLUSTER_DEFAULT_IDLE_GRACE_MS = 5000
export let CLUSTER_RELEVANCE_RING_CELLS = 3
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
  if (!(Number.isFinite(radius) && radius > 0)) throw new ClusterConfigError('cluster-needs-planet-radius', `radius ${JSON.stringify(radius ?? null)} is not a positive finite number: every limit below is an angle or a chord over one sphere of this radius, and a radius that is not a number turns each of those limits into a comparison against NaN that never refuses, so the resolver refuses it at the boundary instead of letting the anchor lattice raise downstream with no world named`)
  if (!(Number.isFinite(relevanceRadius) && relevanceRadius > 0)) throw new ClusterConfigError('cluster-relevance-radius-not-positive-finite', `relevanceRadius ${JSON.stringify(relevanceRadius ?? null)} is not a positive finite number: it sets the ring reach the link has to cover, so a value that is not a number leaves that limit comparing against NaN and never refusing`)
  if (!(Number.isFinite(maxWeaponRangeM) && maxWeaponRangeM >= 0)) throw new ClusterConfigError('cluster-weapon-range-not-finite', `maxWeaponRangeM ${JSON.stringify(maxWeaponRangeM ?? null)} is not a finite non-negative number: the link has to cover it, so a value that is not a number leaves that limit comparing against NaN and never refusing`)
  const anchorsPerFace = spec.anchorsPerFace ?? CHART_ANCHORS_PER_FACE
  if (!(Number.isInteger(anchorsPerFace) && anchorsPerFace >= 1)) throw new ClusterConfigError('cluster-anchors-per-face-below-one', `anchorsPerFace ${JSON.stringify(anchorsPerFace)} is not an integer of at least 1: the chart anchor lattice cuts each face into that many anchors per side, so anything else is a lattice that cannot be cut`)
  if (spec.memberRadiusM != null && !(Number.isFinite(spec.memberRadiusM) && spec.memberRadiusM > 0)) throw new ClusterConfigError('cluster-member-radius-not-positive-finite', `memberRadiusM ${JSON.stringify(spec.memberRadiusM)} is not a positive finite number: the stay angle it sets has to clear the walkable chart limit, so a value that is not a number leaves that limit comparing against NaN and never refusing`)
  const lattice = createChartAnchorLattice(radius, anchorsPerFace)
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
  if (!Number.isInteger(maxWorlds) || maxWorlds < 1 || maxWorlds > CLUSTER_HEAP_WORLD_CEILING) throw new ClusterConfigError('cluster-worlds-exceed-wasm-heap-budget', `maxWorldsPerProcess ${maxWorlds} is outside 1..${CLUSTER_HEAP_WORLD_CEILING}: the Jolt wasm heap is a fixed ${JOLT_WASM_HEAP_BYTES >> 20} MiB that never grows, ${JOLT_WASM_RESIDENT_BYTES} B of it is resident before any world exists, ${CLUSTER_HEAP_MIRROR_RESERVE} co-located client collision mirrors spend ${JOLT_MIRROR_MARGINAL_BYTES} B of the same heap each, and a cluster world measures ${JOLT_WORLD_MARGINAL_BYTES} B marginal at every N behind a ${CLUSTER_HEAP_RESERVE_FRACTION * 100}% per-world reserve, so ${CLUSTER_HEAP_WORLD_CEILING} is the most that fits; going past the ceiling aborts the process with OOM rather than degrading`)
  return {
    radius, anchorsPerFace, lattice, cellWorstDeg, linkM, memberRadiusM, hz, maxWorlds,
    hysteresisDeg: spec.hysteresisDeg ?? CHART_REANCHOR_HYSTERESIS_DEG,
    stayFactor: CLUSTER_STAY_FACTOR, joinFactor: CLUSTER_JOIN_FACTOR,
    idleGraceMs: spec.idleGraceMs ?? CLUSTER_DEFAULT_IDLE_GRACE_MS,
  }
}

export function declaredWeaponRangeM(worldDef, appDefs = null) {
  let longest = worldDef.maxWeaponRangeM ?? 0
  const combat = worldDef.players?.behaviours?.combat
  if (combat) {
    const combatRange = typeof combat.config?.range === 'number' ? combat.config.range : DEFAULT_COMBAT.range
    if (combatRange > longest) longest = combatRange
  }
  for (const entity of worldDef.entities || []) {
    const appDef = entity?.app ? appDefs?.get?.(entity.app) : undefined
    const editorProps = (appDef?.server || appDef)?.editorProps
    const rangeProp = Array.isArray(editorProps) ? editorProps.find(prop => prop?.key === 'range') : undefined
    if (!rangeProp) continue
    const entityRange = typeof entity.config?.range === 'number' ? entity.config.range : rangeProp.default
    if (typeof entityRange === 'number' && entityRange > longest) longest = entityRange
  }
  return longest
}

// --- hot swap ----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapclusterConfig = (next) => {
  CLUSTER_DEFAULT_LINK_M = next.CLUSTER_DEFAULT_LINK_M
  CLUSTER_DEFAULT_HZ = next.CLUSTER_DEFAULT_HZ
  JOLT_WASM_HEAP_BYTES = next.JOLT_WASM_HEAP_BYTES
  JOLT_WASM_RESIDENT_BYTES = next.JOLT_WASM_RESIDENT_BYTES
  JOLT_MIRROR_MARGINAL_BYTES = next.JOLT_MIRROR_MARGINAL_BYTES
  CLUSTER_HEAP_MIRROR_RESERVE = next.CLUSTER_HEAP_MIRROR_RESERVE
  CLUSTER_SERVER_JOLT_LIMITS = next.CLUSTER_SERVER_JOLT_LIMITS
  JOLT_WORLD_MARGINAL_AT_DEFAULT_LIMITS_BYTES = next.JOLT_WORLD_MARGINAL_AT_DEFAULT_LIMITS_BYTES
  JOLT_WORLD_MARGINAL_BYTES = next.JOLT_WORLD_MARGINAL_BYTES
  CLUSTER_HEAP_RESERVE_FRACTION = next.CLUSTER_HEAP_RESERVE_FRACTION
  CLUSTER_HEAP_WORLD_CEILING = next.CLUSTER_HEAP_WORLD_CEILING
  CLUSTER_DEFAULT_IDLE_GRACE_MS = next.CLUSTER_DEFAULT_IDLE_GRACE_MS
  CLUSTER_RELEVANCE_RING_CELLS = next.CLUSTER_RELEVANCE_RING_CELLS
  ClusterConfigError = next.ClusterConfigError
  resolveClusterConfig = next.resolveClusterConfig
  declaredWeaponRangeM = next.declaredWeaponRangeM
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapclusterConfig)
