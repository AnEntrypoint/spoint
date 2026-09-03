// A placeable SPAWN-POINT marker: the maker drops one (or several) to author where players spawn, instead of a
// hardcoded grid. Each is a small static gizmo (no collider) carrying custom._spawnPoint so a game app (or the
// engine spawn-finder) can collect placed spawn markers via ctx.world.queryEntities. Optional team tag for
// team games. This app itself is inert at runtime -- it only marks a position; the game reads the markers.
export default {
  description: 'Spawn-point marker: drop one or more to author where players (optionally per-team) start or respawn.',
  server: {
    editorProps: [
      { key: 'team', label: 'Team', type: 'select', options: ['any', 'red', 'blue', 'green', 'yellow'], default: 'any' },
      { key: 'showGizmo', label: 'Show marker', type: 'checkbox', default: true },
    ],
    setup(ctx) {
      const c = ctx.config || {}
      // Tag the entity as a spawn point + carry the team so a game can filter. A faint gizmo mesh if requested.
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

// Collect all placed spawn-point positions (optionally filtered by team) from any game app that imports this.
// Reads the live entity set via ctx.world.queryEntities -- a game uses these instead of a hardcoded grid.
export function collectSpawnPoints(ctx, team) {
  const out = []
  for (const e of ctx.world.query(e => e.custom && e.custom._spawnPoint)) {
    if (team && team !== 'any' && e.custom._spawnTeam && e.custom._spawnTeam !== 'any' && e.custom._spawnTeam !== team) continue
    out.push([e.position[0], e.position[1], e.position[2]])
  }
  return out
}
