const SUPPORT_RAY_LENGTH_M = 60

export let TELEPORT_HOLD_MAX_MS = 8000

export function beginTeleportHold(player, { maxMs = TELEPORT_HOLD_MAX_MS, onRelease, probeGroundY = null }) {
  const startedAt = Date.now()
  player.teleportHold = { startedAt, deadline: startedAt + maxMs, onRelease, probeGroundY }
}

const SUPPORT_RAY_DOWN = Object.freeze([0, -1, 0])
const supportRayOrigin = [0, 0, 0]

function groundYBelow(physicsWorld, p) {
  supportRayOrigin[0] = p[0]; supportRayOrigin[1] = p[1]; supportRayOrigin[2] = p[2]
  const r = physicsWorld.raycast(supportRayOrigin, SUPPORT_RAY_DOWN, SUPPORT_RAY_LENGTH_M)
  return r && r.hit && Number.isFinite(r.position?.[1]) ? r.position[1] : null
}

export function stepTeleportHold(player, physicsIntegration) {
  const hold = player.teleportHold
  if (!hold) return false
  const st = player.state
  const world = physicsIntegration.physicsWorld
  const groundY = !world ? null : hold.probeGroundY ? hold.probeGroundY() : groundYBelow(world, st.position)
  const now = Date.now()
  if (groundY !== null || !world || now >= hold.deadline) {
    player.teleportHold = null
    st.onGround = false
    hold.onRelease({ groundHit: groundY !== null, groundY, heldMs: now - hold.startedAt })
    return false
  }
  st.velocity[0] = 0; st.velocity[1] = 0; st.velocity[2] = 0
  st.onGround = true
  return true
}

const _hotSwapTeleportHold = (next) => {
  TELEPORT_HOLD_MAX_MS = next.TELEPORT_HOLD_MAX_MS
  beginTeleportHold = next.beginTeleportHold
  stepTeleportHold = next.stepTeleportHold
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapTeleportHold)
