const CONSTRUCT = {
  enabled: false,
  anchorDir: [0, 1, 0],
  radius: 1000,
  reliefScale: 0,
  maxLevel: 0,
  offsetY: 0,
  center: [0, 0],
  physics: { extent: 1, resolution: 1 },
  seed: 0,
  timeOfDay: { serverAuthoritative: true, dayLengthSec: 600, startFraction: 0.5 },
  weather: { serverAuthoritative: true, type: 'clear', intensity: 0, particleCount: 0 },
  vegetation: { enabled: false }
}

export default {
  presets: ['tps'],
  port: 3001,
  gravity: [0, -9.81, 0],
  relevanceRadius: 100,
  physicsRadius: 50,
  physicsBodyBudget: 128,
  scene: {
    skyColor: 0x87ceeb,
    fogColor: 0x87ceeb,
    fogType: 'exp2',
    fogDensity: 0.001,
    fogNear: 200,
    fogFar: 400,
    ambientColor: 0xffffff,
    ambientIntensity: 0.6,
    sunColor: 0xffffff,
    sunIntensity: 1.2,
    sunPosition: [30, 60, 30],
    fillColor: 0x4488ff,
    fillIntensity: 0.4,
    fillPosition: [-30, 40, -30],
    shadowMapSize: 1024,
    shadowBias: 0.001,
    shadowNormalBias: 0.1
  },
  trustedApps: ['matrix-construct-room', 'tps-game'],
  placeableApps: [],
  terrain: CONSTRUCT,
  entities: [
    { id: 'terrain', app: 'terrain' },
    { id: 'matrix-room', app: 'matrix-construct-room', position: [0, 0, 0] },
    { id: 'tps-game', position: [0, 0, 0], app: 'tps-game' }
  ],
  spawnPoint: [0, 2, 0]
}