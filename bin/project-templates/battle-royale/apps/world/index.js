// battle-royale template world-def: a wide flat floor, a spread ring of spawn points around the map edge
// (drop-zone style, farthest from the zone center), and a shrinking storm zone (apps/shrinking-zone --
// ships inside the spoint package itself, resolves from node_modules/spoint/apps/shrinking-zone with zero
// project-side copy needed -- wraps ctx.defineShrinkingZone: ring visual + out-of-bounds damage/push,
// closing from startRadius to endRadius over shrinkSeconds after startDelaySeconds) so a fresh
// battle-royale project boots into a real closing-circle survival match instead of an empty box. Add more
// `spawn-point` entities around the edge, or `weapon-spawn` markers (apps/weapon-spawn) to author where
// loot appears for a weapon system to consume, to grow the map; see apps/README.md (copied from the
// spoint package) for the full apps/ convention.
export default {
  spawnPoint: [0, 5, 0],
  gravity: [0, -9.81, 0],
  // shrinking-zone-ring is a pure-visual sub-entity dynamically spawned by apps/shrinking-zone's own
  // defineShrinkingZone (never placed directly by id in entities[] below) -- singleplayer's app-prefetch
  // only loads apps named in entities[].app or here, so it needs an explicit placeableApps entry or the
  // ring silently has no server-side app logic (see project/ragdoll-brawl-arena-no-joint-api).
  placeableApps: ['shrinking-zone-ring'],
  entities: [
    { id: 'br-floor', app: 'floor', position: [0, -0.5, 0], config: { width: 300, depth: 300, thickness: 1, color: '#4a5f4a' } },

    // Fall-plane safety net (apps/respawn-zone, ships inside the spoint package itself): teleports a
    // player who somehow falls off/through the map back to the world spawn instead of sitting at the
    // engine's own -100 kill-plane clamp indefinitely.
    { id: 'safety-net', app: 'respawn-zone', position: [0, 5, 0], config: { minY: -20, respawn: [0, 5, 0] } },

    { id: 'storm', app: 'shrinking-zone', position: [0, 0, 0], config: { startRadius: 140, endRadius: 10, shrinkSeconds: 180, startDelaySeconds: 15, damagePerSec: 6 } },

    { id: 'spawn-n', app: 'spawn-point', position: [0, 1, 130] },
    { id: 'spawn-ne', app: 'spawn-point', position: [92, 1, 92] },
    { id: 'spawn-e', app: 'spawn-point', position: [130, 1, 0] },
    { id: 'spawn-se', app: 'spawn-point', position: [92, 1, -92] },
    { id: 'spawn-s', app: 'spawn-point', position: [0, 1, -130] },
    { id: 'spawn-sw', app: 'spawn-point', position: [-92, 1, -92] },
    { id: 'spawn-w', app: 'spawn-point', position: [-130, 1, 0] },
    { id: 'spawn-nw', app: 'spawn-point', position: [-92, 1, 92] },

    { id: 'loot-1', app: 'weapon-spawn', position: [30, 1, 30], config: { weaponType: 'rifle' } },
    { id: 'loot-2', app: 'weapon-spawn', position: [-30, 1, 30], config: { weaponType: 'shotgun' } },
    { id: 'loot-3', app: 'weapon-spawn', position: [30, 1, -30], config: { weaponType: 'pistol' } },
    { id: 'loot-4', app: 'weapon-spawn', position: [-30, 1, -30], config: { weaponType: 'sniper' } },
  ]
}
