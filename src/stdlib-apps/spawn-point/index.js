export default {
  description: 'Spawn-point marker: drop one or more to author where players (optionally per-team) start or respawn.',
  server: {
    editorProps: [
      { key: 'team', label: 'Team', type: 'select', options: ['any', 'red', 'blue', 'green', 'yellow'], default: 'any' },
      { key: 'showGizmo', label: 'Show marker', type: 'checkbox', default: true },
    ],
    setup(ctx) {
      const c = ctx.config || {}
      ctx.entity.custom = {
        ...(ctx.entity.custom || {}),
        _spawnPoint: true,
        _spawnTeam: c.team ?? 'any',
        ...(c.showGizmo === false ? {} : { mesh: 'capsule', color: '#33cc88', sx: 0.4, sy: 0.9, sz: 0.4 }),
      }
      ctx.onConfigChange?.((cfg) => { if (ctx.entity.custom) ctx.entity.custom._spawnTeam = cfg.team ?? 'any' })
    },
  },
}

export function collectSpawnPoints(ctx, team) {
  const out = []
  for (const e of ctx.world.query(e => e.custom && e.custom._spawnPoint)) {
    if (team && team !== 'any' && e.custom._spawnTeam && e.custom._spawnTeam !== 'any' && e.custom._spawnTeam !== team) continue
    out.push([e.position[0], e.position[1], e.position[2]])
  }
  return out
}
