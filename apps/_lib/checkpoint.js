export function defineCheckpoint(spec = {}, appCtx) {
  if (!appCtx) throw new TypeError('[checkpoint] appCtx is required')
  if (!Array.isArray(spec.spawn) || spec.spawn.length < 3) throw new TypeError('[checkpoint] spawn [x,y,z] is required')
  const spawn = [spec.spawn[0], spec.spawn[1], spec.spawn[2]]
  const minY = (typeof spec.minY === 'number' && Number.isFinite(spec.minY)) ? spec.minY : -50
  const defRadius = spec.radius ?? 3
  const cps = (spec.checkpoints || []).map((c, i) => ({ position: c.position, r2: (c.radius ?? defRadius) ** 2, index: i }))
  const _cp = new Map()
  const _cpIndex = new Map()

  const checkpoint = {
    checkpointOf(pid) { return _cp.get(pid) || spawn },
    setCheckpoint(pid, pos) { if (Array.isArray(pos) && pos.length >= 3) _cp.set(pid, [pos[0], pos[1], pos[2]]) },
    reset() { _cp.clear(); _cpIndex.clear() },
    tick(_dt) {
      for (const player of appCtx.players.getAll()) {
        const pp = player.state?.position; if (!pp) continue
        for (const c of cps) {
          const dx = pp[0] - c.position[0], dy = pp[1] - c.position[1], dz = pp[2] - c.position[2]
          const insideVolume = dx * dx + dy * dy + dz * dz <= c.r2
          if (insideVolume) {
            const advancesCheckpoint = (_cpIndex.get(player.id) ?? -1) < c.index
            if (advancesCheckpoint) {
              _cpIndex.set(player.id, c.index)
              _cp.set(player.id, [c.position[0], c.position[1], c.position[2]])
              if (typeof spec.onCheckpoint === 'function') spec.onCheckpoint(appCtx, player.id, c.index)
            }
          }
        }
        const fellBelowKillPlane = pp[1] < minY
        if (fellBelowKillPlane) {
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
