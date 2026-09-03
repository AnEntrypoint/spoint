// A placeable WEAPON-SPAWN marker: a maker drops one (or several) to author where weapon pickups
// spawn, mirroring apps/spawn-point's own marker pattern exactly (custom._weaponSpawn instead of
// custom._spawnPoint, an id-per-entity + optional weaponType/team tag instead of a team-only tag).
// This app itself is inert at runtime -- it only marks a position; a game (or, for this PRD row,
// apps/playtest-bot's balance-visit tracker) reads the markers via collectWeaponSpawns below,
// exactly the way apps/tps-game/server.js's findSpawnPoints/apps/playtest-bot's _auditSpawnLOS read
// spawn-point markers via apps/spawn-point's own collectSpawnPoints export.
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

// Collect all placed weapon-spawn positions (optionally filtered by team) from any game/bot app that
// imports this -- same shape as apps/spawn-point's collectSpawnPoints, but keeps the entity id (a
// balance tracker needs a stable per-spawn identity to key visit counts by, not just a bare position).
export function collectWeaponSpawns(ctx, team) {
  const out = []
  for (const e of ctx.world.query(e => e.custom && e.custom._weaponSpawn)) {
    if (team && team !== 'any' && e.custom._weaponSpawnTeam && e.custom._weaponSpawnTeam !== 'any' && e.custom._weaponSpawnTeam !== team) continue
    out.push({ id: e.id, position: [e.position[0], e.position[1], e.position[2]], weaponType: e.custom._weaponType ?? 'rifle' })
  }
  return out
}
