// defineCheckpoint(spec, appCtx) -> per-player last-checkpoint tracking + fall-plane respawn. Parkour,
// platformer, tower-climb and racing games all re-implement "remember where the player last was safe,
// and if they fall below Y=minY teleport them back" -- only tps-game has the fall loop. This wraps it:
// call checkpoint.tick(dt) once per server tick from the owning app's update(ctx,dt); it scans players,
// updates each one's checkpoint when they enter a checkpoint volume, and respawns any who fall below
// the kill plane. Uses ctx.players.getAll()/setPosition -- no direct physics touch.
//
// spec = {
//   spawn: [x,y,z],                    // default checkpoint (required) -- where a player with no checkpoint respawns
//   minY?: number,                     // fall-plane; a player below this respawns at their checkpoint (default -50)
//   checkpoints?: [{ position:[x,y,z], radius?:number }],  // volumes that set a player's checkpoint on entry
//   radius?: number,                   // default checkpoint volume radius if a checkpoint omits it (default 3)
//   onRespawn?(ctx, playerId),         // fired after a fallen player is teleported back
//   onCheckpoint?(ctx, playerId, index), // fired when a player reaches a new checkpoint
// }
// Returns { tick(dt), checkpointOf(playerId) -> [x,y,z], setCheckpoint(playerId, pos), reset() }.

export function defineCheckpoint(spec = {}, appCtx) {
  if (!appCtx) throw new TypeError('[checkpoint] appCtx is required')
  if (!Array.isArray(spec.spawn) || spec.spawn.length < 3) throw new TypeError('[checkpoint] spawn [x,y,z] is required')
  const spawn = [spec.spawn[0], spec.spawn[1], spec.spawn[2]]
  const minY = (typeof spec.minY === 'number' && Number.isFinite(spec.minY)) ? spec.minY : -50
  const defRadius = spec.radius ?? 3
  const cps = (spec.checkpoints || []).map((c, i) => ({ position: c.position, r2: (c.radius ?? defRadius) ** 2, index: i }))
  const _cp = new Map()      // playerId -> [x,y,z]
  const _cpIndex = new Map() // playerId -> highest checkpoint index reached

  const checkpoint = {
    checkpointOf(pid) { return _cp.get(pid) || spawn },
    setCheckpoint(pid, pos) { if (Array.isArray(pos) && pos.length >= 3) _cp.set(pid, [pos[0], pos[1], pos[2]]) },
    reset() { _cp.clear(); _cpIndex.clear() },
    tick(_dt) {
      for (const player of appCtx.players.getAll()) {
        const pp = player.state?.position; if (!pp) continue
        // reached a new checkpoint volume?
        for (const c of cps) {
          const dx = pp[0] - c.position[0], dy = pp[1] - c.position[1], dz = pp[2] - c.position[2]
          if (dx * dx + dy * dy + dz * dz <= c.r2) {
            if ((_cpIndex.get(player.id) ?? -1) < c.index) {
              _cpIndex.set(player.id, c.index)
              _cp.set(player.id, [c.position[0], c.position[1], c.position[2]])
              if (typeof spec.onCheckpoint === 'function') spec.onCheckpoint(appCtx, player.id, c.index)
            }
          }
        }
        // fell below the kill plane -> respawn at last checkpoint (or spawn)
        if (pp[1] < minY) {
          const target = _cp.get(player.id) || spawn
          appCtx.players.setPosition(player.id, target)
          if (typeof spec.onRespawn === 'function') spec.onRespawn(appCtx, player.id)
        }
      }
    },
  }
  return checkpoint
}

export default defineCheckpoint
