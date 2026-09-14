export default {
  spawnPoint: [0, 2, 0],
  gravity: [0, -9.81, 0],
  entities: [
    { id: 'spawn-blocked-a', app: 'spawn-point', position: [-5, 1, 0] },
    { id: 'wall-between', app: 'box-static', position: [0, 2, 0], config: { hx: 0.5, hy: 3, hz: 5, color: '#996644' } },
    { id: 'spawn-blocked-b', app: 'spawn-point', position: [5, 1, 0] },
    { id: 'spawn-clear-a', app: 'spawn-point', position: [-5, 1, 20] },
    { id: 'spawn-clear-b', app: 'spawn-point', position: [5, 1, 20] },
    { id: 'los-test-bot', app: 'playtest-bot', position: [0, 1, 40], config: { wanderRadius: 5, checkSpawnLOS: true } },
  ],
}
