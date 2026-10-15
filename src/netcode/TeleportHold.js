const SUPPORT_RAY_LENGTH_M = 60

export let TELEPORT_HOLD_MAX_MS = 8000

export function beginTeleportHold(player, { maxMs = TELEPORT_HOLD_MAX_MS, onRelease, probeGroundY = null }) {
  const startedAt = Date.now()
  player.teleportHold = { startedAt, deadline: startedAt + maxMs, onRelease, probeGroundY }
}

function groundYBelow(physicsWorld, p) {
  const r = physicsWorld.raycast([p[0], p[1], p[2]], [0, -1, 0], SUPPORT_RAY_LENGTH_M)
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

// --- hot swap ----------------------------------------------------------------------------
// An edit to this file used to be classified RELOAD: findBoundaries walked from here to the app
// root and found no acceptor, so a save cost a whole page load. No boundary ABOVE this file can
// fix that, because a re-import is a new module instance and every importer keeps reading the
// one it imported at boot. What can is this file itself: an ESM import is a LIVE binding to this
// instance's export bindings, so re-assigning them here is visible to every importer already
// holding them. Self-accepting therefore turns the cost of a save into one module fetch.
// This re-points code only. It does not rebuild state the page already built, and every export
// below is re-assigned, so nothing an importer holds is left pointing at the previous copy.
const _hotSwapTeleportHold = (next) => {
  TELEPORT_HOLD_MAX_MS = next.TELEPORT_HOLD_MAX_MS
  beginTeleportHold = next.beginTeleportHold
  stepTeleportHold = next.stepTeleportHold
}
globalThis.__spointHmr?.acceptSelf?.(import.meta.url, _hotSwapTeleportHold)
