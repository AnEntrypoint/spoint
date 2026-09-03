// definePickup(spec, appCtx) -> a per-tick nearest-player-in-radius trigger, wrapping the
// scan pattern every prototype (and AppRuntimeTick.js's own _tickInteractables) hand-rolls.
// spec = { radius?: number, cooldown?: number (ms), oneShot?: boolean, onCollect(ctx, player, pickup) }
// Call pickup.tick(dt) once per server tick from the owning app's update(ctx,dt) -- this app owns
// polling its OWN entity's position against ctx.players.getAll(), it does not register a runtime-level
// watch (see AppContext.onPlayerProximity for the runtime-owned, O(1)-registration equivalent).

export function definePickup(spec = {}, appCtx) {
  if (!appCtx) throw new TypeError('[pickup] appCtx is required')
  if (spec.radius != null && (typeof spec.radius !== 'number' || !Number.isFinite(spec.radius) || spec.radius < 0)) {
    throw new TypeError('[pickup] radius must be a non-negative finite number')
  }
  if (typeof spec.onCollect !== 'function') throw new TypeError('[pickup] onCollect(ctx, player, pickup) is required')
  const radius = spec.radius ?? 1.5
  const radius2 = radius * radius
  const cooldownMs = spec.cooldown ?? 0
  const oneShot = !!spec.oneShot
  const _lastCollect = new Map() // playerId -> ms timestamp
  let _collected = false

  const pickup = {
    get collected() { return _collected },
    reset() { _collected = false; _lastCollect.clear() },
    tick(dt) {
      if (oneShot && _collected) return
      const pos = appCtx.entity.position
      if (!pos) return
      const now = Date.now()
      for (const player of appCtx.players.getAll()) {
        const pp = player.state?.position; if (!pp) continue
        const dx = pp[0] - pos[0], dy = pp[1] - pos[1], dz = pp[2] - pos[2]
        if (dx * dx + dy * dy + dz * dz > radius2) continue
        if (cooldownMs > 0) {
          const last = _lastCollect.get(player.id) || 0
          if (now - last < cooldownMs) continue
          _lastCollect.set(player.id, now)
        }
        if (oneShot) _collected = true
        spec.onCollect(appCtx, player, pickup)
        if (oneShot) return
      }
    }
  }
  return pickup
}

export default definePickup
