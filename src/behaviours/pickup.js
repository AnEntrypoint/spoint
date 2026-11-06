import { parseDefineSpec, DEFINE_SPEC_SCHEMAS } from './specBoundary.js'

export function definePickup(spec = {}, appCtx) {
  if (!appCtx) throw new TypeError('[pickup] appCtx is required')
  spec = parseDefineSpec('definePickup', spec, DEFINE_SPEC_SCHEMAS.pickup)
  const { radius, cooldown: cooldownMs, oneShot } = spec
  const radius2 = radius * radius
  const _lastCollectMsByPlayer = new Map()
  let _collected = false

  const pickup = {
    get collected() { return _collected },
    reset() { _collected = false; _lastCollectMsByPlayer.clear() },
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
          const last = _lastCollectMsByPlayer.get(player.id) || 0
          if (now - last < cooldownMs) continue
          _lastCollectMsByPlayer.set(player.id, now)
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
