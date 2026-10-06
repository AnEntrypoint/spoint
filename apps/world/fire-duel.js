export default {
  name: 'fire-duel',
  presets: ['arena'],
  tickRate: 60,
  gravity: [0, -9.81, 0],
  spawnPoints: [[-3, 1.2, 0], [3, 1.2, 0]],
  netcode: {
    profile: 'rollback',
    peers: 2,
    rollback: { inputDelayTicks: 1, maxRollbackTicks: 12, checksumIntervalTicks: 30 },
  },
  entities: [
    { id: 'fire', app: 'fire-duel', position: [0, 0, 0] },
  ],
}
