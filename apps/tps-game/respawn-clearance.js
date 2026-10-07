import { DEFAULT_HITBOX } from '../../src/netcode/Hitscan.js'
import { spawnSurfaceY } from '../../src/shared/SpawnSurface.js'
import { capsuleRadiusM, capsuleHeightM, footprintBlockers } from '../../src/apps/AppGameplay.js'

const RESPAWN_LIFT_M = 2

const MAX_AUTHORED_SURFACE_DELTA_M = 2

const MIN_SAFE_DISTANCE_M = 25

function standingOffsetM(hitbox) {
  if (Number.isFinite(hitbox?.centerHeight) && hitbox.centerHeight > 0) return hitbox.centerHeight
  const derived = capsuleHeightM(hitbox) / 2
  return derived > 0 ? derived : DEFAULT_HITBOX.centerHeight
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
