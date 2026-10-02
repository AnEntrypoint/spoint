export default {
  presets: ['tps', 'platformer'],
  port: 3002,
  physicsBodyBudget: 512,
  scene: {
    skyColor: 0x87ceeb,
    fogColor: 0x87ceeb,
    fogNear: 10000,
    fogFar: 20000,
    ambientColor: 0xfff4d6,
    ambientIntensity: 0.3,
    sunColor: 0xffffff,
    sunIntensity: 1.5,
    sunPosition: [21, 50, 20],
    fillColor: 0x4488ff,
    fillIntensity: 0.4,
    fillPosition: [-20, 30, -10],
    shadowMapSize: 1024,
    shadowBias: 0.0038,
    shadowNormalBias: 0.6,
    shadowRadius: 12,
    shadowBlurSamples: 8
  },
  entities: [
    { id: 'env-deathrun-kosova', model: './apps/maps/deathrun_kosova.glb', position: [0, 0, 0], scale: [1, 1, 1], app: 'placed-model', config: { collider: 'trimesh' }, custom: { _interior: true } },
    { id: 'deathrun', position: [0, 0, 0], app: 'deathrun', config: { map: 'deathrun_kosova', minY: -50 } },
    { id: 'dr-checkpoint-0', app: 'checkpoint-marker', position: [0, 15, 0], config: { order: 0, radius: 5 } },
    { id: 'dr-checkpoint-1', app: 'checkpoint-marker', position: [17, 12.43, -7.4], config: { order: 1, radius: 5 } },
  ],
  spawnPoint: [0, 15.3, 0]
}
