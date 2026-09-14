export default {
  spawnPoint: [0, 5, 0],
  gravity: [0, -9.81, 0],
  placeableApps: ['shrinking-zone-ring'],
  entities: [
    { id: 'br-floor', app: 'floor', position: [0, -0.5, 0], config: { width: 300, depth: 300, thickness: 1, color: '#4a5f4a' } },

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
