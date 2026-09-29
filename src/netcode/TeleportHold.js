const SUPPORT_RAY_LENGTH_M = 60

export const TELEPORT_HOLD_MAX_MS = 8000

export function beginTeleportHold(player, { maxMs = TELEPORT_HOLD_MAX_MS, onRelease }) {
  const startedAt = Date.now()
  player.teleportHold = { startedAt, deadline: startedAt + maxMs, onRelease }
}

function groundBelow(physicsWorld, p) {
  const r = physicsWorld.raycast([p[0], p[1], p[2]], [0, -1, 0], SUPPORT_RAY_LENGTH_M)
  return r && r.hit && Number.isFinite(r.position?.[1]) ? r : null
}

export function stepTeleportHold(player, physicsIntegration) {
  const hold = player.teleportHold
  if (!hold) return false
  const st = player.state
  const world = physicsIntegration.physicsWorld
  const hit = world ? groundBelow(world, st.position) : null
  const now = Date.now()
  if (hit || !world || now >= hold.deadline) {
    player.teleportHold = null
    st.onGround = false
    hold.onRelease({ groundHit: !!hit, groundY: hit ? hit.position[1] : null, heldMs: now - hold.startedAt })
    return false
  }
  st.velocity[0] = 0; st.velocity[1] = 0; st.velocity[2] = 0
  st.onGround = true
  return true
}
