const TERRAIN = {
  enabled: true,
  anchorDir: [-0.641, 0.2558, 0.7237],
  radius: 63600,
  reliefScale: 0.001,
  maxLevel: 13,
  offsetY: 0,
  center: [0, 0],
  bakedHeightfield: '/apps/world/tps-game.hf',
  physics: { extent: 256, resolution: 2 },
  seed: 1337,
  weather: { serverAuthoritative: true, type: 'rain', intensity: 1, particleCount: 3000 },
}

export default {
  port: 3099,
  tickRate: 64,
  entityTickRate: 15,
  gravity: [0, -18.0, 0],
  relevanceRadius: 0,
  physicsRadius: 30,
  physicsBodyBudget: 512,
  trustedApps: ['terrain'],
  placeableApps: [],
  terrain: TERRAIN,
  entities: [
    { id: 'terrain', app: 'terrain', config: TERRAIN },
  ],
  spawnPoint: [0, 15.3, 0],
}
