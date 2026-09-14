export default {
  port: 3099,
  tickRate: 30,
  gravity: [0, -18.0, 0],
  spawnPoint: [0, 2, 0],
  placeableApps: ['item-pickup'],
  entities: [
    { id: 'gold-pickup-1', app: 'item-pickup', position: [0, 2, 0], config: { item: 'gold', amount: 10, radius: 2.5, respawnMs: 600000, poolId: 'default' } },
    { id: 'medkit-pickup-1', app: 'item-pickup', position: [0, 2, 0], config: { item: 'medkit', amount: 8, radius: 2.5, respawnMs: 600000, poolId: 'default' } },
  ],
}
