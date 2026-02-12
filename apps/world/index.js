export default {
  port: 3000,
  tickRate: 128,
  gravity: [0, -9.81, 0],
  movement: {
    maxSpeed: 4.0,
    groundAccel: 10.0,
    airAccel: 1.0,
    friction: 6.0,
    stopSpeed: 2.0,
    jumpImpulse: 4.0,
    collisionRestitution: 0.2,
    collisionDamping: 0.25
  },
  player: {
    health: 100,
    capsuleRadius: 0.4,
    capsuleHalfHeight: 0.9,
    crouchHalfHeight: 0.45,
    mass: 120,
    modelScale: 1.323,
    feetOffset: 0.212
  },
  scene: {
    skyColor: 0x87ceeb,
    fogColor: 0x87ceeb,
    fogNear: 80,
    fogFar: 200,
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
  camera: {
    fov: 70,
    shoulderOffset: 0.35,
    headHeight: 0.4,
    zoomStages: [0, 1.5, 3, 5, 8],
    defaultZoomIndex: 2,
    followSpeed: 12.0,
    snapSpeed: 30.0,
    mouseSensitivity: 0.002,
    pitchRange: [-1.4, 1.4]
  },
  animation: {
    mixerTimeScale: 1.3,
    walkTimeScale: 2.0,
    sprintTimeScale: 0.56,
    fadeTime: 0.15
  },
  entities: [
    { id: 'environment', model: './apps/tps-game/schwust.glb', position: [0, 0, 0], app: 'environment' },
    { id: 'game', position: [0, 0, 0], app: 'tps-game' },
    { id: 'power-crates', position: [0, 0, 0], app: 'power-crate' }
  ],
  playerModel: './apps/tps-game/Cleetus.vrm',
  spawnPoint: [-35, 3, -65]
}
