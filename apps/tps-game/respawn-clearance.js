import { DEFAULT_HITBOX } from '../../src/netcode/Hitscan.js'
import { spawnSurfaceY } from '../../src/shared/SpawnSurface.js'

const RESPAWN_LIFT_M = 2

const PROBE_SKIN_M = 0.02

const VOID_PROBE_DEPTH_M = 1.5

const MAX_FOOTPRINT_INTRUSION_M = 0.15

const MAX_AUTHORED_SURFACE_DELTA_M = 2

const FOOTPRINT_RING_FRACTIONS = [0.5, 1]

const FOOTPRINT_DIR_COUNT = 8

const FALLBACK_CAPSULE_RADIUS_M = 0.6

const MIN_SAFE_DISTANCE_M = 25

const FOOTPRINT_OFFSETS = (() => {
  const offsets = [[0, 0]]
  for (const fraction of FOOTPRINT_RING_FRACTIONS) {
    for (let i = 0; i < FOOTPRINT_DIR_COUNT; i++) {
      const angle = (i * 2 * Math.PI) / FOOTPRINT_DIR_COUNT
      offsets.push([Math.cos(angle) * fraction, Math.sin(angle) * fraction])
    }
  }
  return offsets
})()

function capsuleRadiusM(hitbox) {
  return Number.isFinite(hitbox?.radiusSq) && hitbox.radiusSq > 0
    ? Math.sqrt(hitbox.radiusSq)
    : FALLBACK_CAPSULE_RADIUS_M
}

function capsuleHeightM(hitbox) {
  if (Number.isFinite(hitbox?.height) && hitbox.height > 0) return hitbox.height
  const derived = 2 * (Number.isFinite(hitbox?.centerHeight) ? hitbox.centerHeight : DEFAULT_HITBOX.centerHeight)
  return derived > 0 ? derived : DEFAULT_HITBOX.height
}

function standingOffsetM(hitbox) {
  if (Number.isFinite(hitbox?.centerHeight) && hitbox.centerHeight > 0) return hitbox.centerHeight
  const derived = capsuleHeightM(hitbox) / 2
  return derived > 0 ? derived : DEFAULT_HITBOX.centerHeight
}

function capsuleBottomRiseM(distanceM, radiusM) {
  if (!(distanceM > 0)) return 0
  if (distanceM >= radiusM) return radiusM
  return radiusM - Math.sqrt(radiusM * radiusM - distanceM * distanceM)
}

function withinContactDisc(distanceM, radiusM) {
  return distanceM < radiusM
}

function authoredSurfaceM(ctx, sp, hitbox, radiusM) {
  const terrainY = ctx.terrainHeightAt(sp[0], sp[2])
  const standingOffset = standingOffsetM(hitbox)
  const poseY = Number.isFinite(terrainY) ? Math.max(sp[1], terrainY) : sp[1]
  const feetY = spawnSurfaceY((origin, direction, length) => ctx.raycast(origin, direction, length), sp, {
    standingOffset,
    headroom: RESPAWN_LIFT_M + capsuleHeightM(hitbox),
    terrainY,
    radius: radiusM,
  })
  return { feetY, poseY, standingOffset }
}

function surfaceYOf(hit) {
  return hit && hit.hit && Number.isFinite(hit.position?.[1]) ? hit.position[1] : null
}

export function footprintBlockers(ctx, sp, feetY, hitbox = DEFAULT_HITBOX) {
  const radiusM = capsuleRadiusM(hitbox)
  const heightM = capsuleHeightM(hitbox)
  const blockers = []
  for (const [unitX, unitZ] of FOOTPRINT_OFFSETS) {
    const offsetX = unitX * radiusM
    const offsetZ = unitZ * radiusM
    const distanceM = Math.hypot(offsetX, offsetZ)
    const riseM = capsuleBottomRiseM(distanceM, radiusM)
    const bottomY = feetY + riseM
    const topY = feetY + heightM - riseM
    const sampleX = sp[0] + offsetX
    const sampleZ = sp[2] + offsetZ
    const probeLengthM = topY - bottomY + VOID_PROBE_DEPTH_M
    if (!(probeLengthM > 0)) continue
    const support = ctx.raycast([sampleX, topY - PROBE_SKIN_M, sampleZ], [0, -1, 0], probeLengthM)
    const supportY = surfaceYOf(support)
    if (supportY === null) {
      if (withinContactDisc(distanceM, radiusM)) {
        blockers.push({ kind: 'void', x: sampleX, z: sampleZ, offsetM: distanceM, surfaceY: null, intrusionM: null })
      }
      continue
    }
    if (supportY > bottomY + MAX_FOOTPRINT_INTRUSION_M) {
      blockers.push({ kind: 'intruding', x: sampleX, z: sampleZ, offsetM: distanceM, surfaceY: supportY, intrusionM: supportY - bottomY })
    }
  }
  return blockers
}

function playerOverlaps(ctx, sp, feetY, hitbox, exclude) {
  const overlapDiameterM = 2 * capsuleRadiusM(hitbox)
  const heightM = capsuleHeightM(hitbox)
  const blockers = []
  for (const player of ctx.players?.getAll?.() ?? []) {
    if (!player.state || exclude(player)) continue
    const occupied = player.state.position
    const distanceM = Math.hypot(sp[0] - occupied[0], sp[2] - occupied[2])
    if (distanceM >= overlapDiameterM) continue
    if (Math.abs(occupied[1] - feetY) >= heightM) continue
    blockers.push({
      kind: 'player',
      playerId: player.id,
      x: occupied[0],
      z: occupied[2],
      offsetM: distanceM,
      surfaceY: occupied[1],
      intrusionM: overlapDiameterM - distanceM,
    })
  }
  return blockers
}

export function evaluateSpawnPoint(ctx, sp, hitbox = DEFAULT_HITBOX, exclude = () => false) {
  const radiusM = capsuleRadiusM(hitbox)
  const { feetY, poseY, standingOffset } = authoredSurfaceM(ctx, sp, hitbox, radiusM)
  if (feetY === null) {
    return {
      sp,
      feetY: null,
      pose: [...sp],
      blockers: [{ kind: 'no-surface', x: sp[0], z: sp[2], offsetM: 0, surfaceY: null, intrusionM: null }],
    }
  }
  const deltaM = feetY - sp[1]
  const bandLowY = poseY - 2 * standingOffset
  if (feetY < bandLowY || feetY > poseY || Math.abs(deltaM) > MAX_AUTHORED_SURFACE_DELTA_M) {
    return {
      sp,
      feetY,
      pose: [sp[0], feetY + RESPAWN_LIFT_M, sp[2]],
      blockers: [{ kind: 'surface-mismatch', x: sp[0], z: sp[2], offsetM: 0, surfaceY: feetY, intrusionM: null, deltaM }],
    }
  }
  const blockers = footprintBlockers(ctx, sp, feetY, hitbox)
  for (const overlap of playerOverlaps(ctx, sp, feetY, hitbox, exclude)) blockers.push(overlap)
  return { sp, feetY, pose: [sp[0], feetY + RESPAWN_LIFT_M, sp[2]], blockers }
}

function isFinitePoint(point) {
  return Array.isArray(point) && point.length === 3 && point.every(Number.isFinite)
}

function orderByPlayerDistance(ctx, spawnPoints, exclude, minSafeDistance) {
  const active = ctx.players.getAll().filter(player => player.state && !exclude(player))
  if (active.length === 0) return [...spawnPoints]
  const scored = spawnPoints.map(sp => ({
    sp,
    nearestM: Math.min(...active.map(player => Math.hypot(sp[0] - player.state.position[0], sp[2] - player.state.position[2]))),
  }))
  const safe = scored.filter(entry => entry.nearestM >= minSafeDistance)
  const pool = safe.length > 0 ? safe : scored.sort((a, b) => b.nearestM - a.nearestM)
  return pool.map(entry => entry.sp)
}

export function pickClearSpawnPose(ctx, spawnPoints, { exclude = () => false, minSafeDistance = MIN_SAFE_DISTANCE_M, hitbox = DEFAULT_HITBOX } = {}) {
  if (!Array.isArray(spawnPoints)) throw new TypeError(`[tps-game] spawnPoints must be an array, got ${spawnPoints}`)
  const usable = spawnPoints.filter(isFinitePoint)
  if (usable.length === 0) throw new Error(`[tps-game] respawn clearance: ${spawnPoints.length} spawn point(s) supplied, ${usable.length} usable`)
  const ordered = orderByPlayerDistance(ctx, usable, exclude, minSafeDistance)
  let leastBlocked = null
  for (const sp of ordered) {
    const evaluated = evaluateSpawnPoint(ctx, sp, hitbox, exclude)
    if (evaluated.blockers.length === 0) return evaluated.pose
    if (!leastBlocked || evaluated.blockers.length < leastBlocked.blockers.length) leastBlocked = evaluated
  }
  console.error(`[tps-game] respawn clearance: all ${usable.length} spawn point(s) blocked; using least-blocked ${JSON.stringify(leastBlocked.sp)} with ${leastBlocked.blockers.length} blocked footprint sample(s) ${JSON.stringify(leastBlocked.blockers)}`)
  return leastBlocked.pose
}
