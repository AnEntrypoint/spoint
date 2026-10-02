export default {
  name: 'rollback-duel',
  presets: ['arena'],
  tickRate: 60,
  gravity: [0, -9.81, 0],
  spawnPoints: [[-3, 1.2, 0], [3, 1.2, 0]],
  netcode: {
    profile: 'rollback',
    peers: 2,
    rollback: { inputDelayTicks: 1, maxRollbackTicks: 12, checksumIntervalTicks: 30 }
  },
  entities: [
    { id: 'crate-a', app: 'box-dynamic', position: [0, 2, 2], config: { hx: 0.5, hy: 0.5, hz: 0.5, mass: 20 } },
    { id: 'crate-b', app: 'box-dynamic', position: [0, 3.2, 2], config: { hx: 0.5, hy: 0.5, hz: 0.5, mass: 20 } }
  ]
}
