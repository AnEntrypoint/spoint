export default {
  description: 'Weapon-spawn marker: drop one or more to author where weapon pickups spawn, for balance analysis.',
  server: {
    editorProps: [
      { key: 'weaponType', label: 'Weapon type', type: 'text', default: 'rifle' },
      { key: 'team', label: 'Team', type: 'select', options: ['any', 'red', 'blue', 'green', 'yellow'], default: 'any' },
      { key: 'showGizmo', label: 'Show marker', type: 'checkbox', default: true },
    ],
    setup(ctx) {
      const c = ctx.config || {}
      ctx.entity.custom = {
        ...(ctx.entity.custom || {}),
        _weaponSpawn: true,
        _weaponType: c.weaponType ?? 'rifle',
        _weaponSpawnTeam: c.team ?? 'any',
        ...(c.showGizmo === false ? {} : { mesh: 'box', color: '#ff8822', sx: 0.5, sy: 0.5, sz: 0.5 }),
      }
      ctx.onConfigChange?.((cfg) => {
        if (!ctx.entity.custom) return
        ctx.entity.custom._weaponType = cfg.weaponType ?? ctx.entity.custom._weaponType
        ctx.entity.custom._weaponSpawnTeam = cfg.team ?? ctx.entity.custom._weaponSpawnTeam
      })
    },
  },
}

export function collectWeaponSpawns(ctx, team) {
  const out = []
  for (const e of ctx.world.query(e => e.custom && e.custom._weaponSpawn)) {
    if (team && team !== 'any' && e.custom._weaponSpawnTeam && e.custom._weaponSpawnTeam !== 'any' && e.custom._weaponSpawnTeam !== team) continue
    out.push({ id: e.id, position: [e.position[0], e.position[1], e.position[2]], weaponType: e.custom._weaponType ?? 'rifle' })
  }
  return out
}
