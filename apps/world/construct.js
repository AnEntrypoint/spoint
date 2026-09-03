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
  port: 3001,
  tickRate: 64,
  entityTickRate: 15,
  gravity: [0, -9.81, 0],
  relevanceRadius: 100,
  physicsRadius: 50,
  physicsBodyBudget: 128,
  movement: {
    maxSpeed: 7.0,
    sprintSpeed: 12.0,
    groundAccel: 300.0,
    airAccel: 30.0,
    airMaxSpeed: 0.15,
    airSpeedCap: 16.0,
    friction: 5.0,
    stopSpeed: 1.0,
    jumpImpulse: 5.5,
    collisionRestitution: 0.2,
    collisionDamping: 0.25
  },
  player: {
    health: 100,
    capsuleRadius: 0.28,
    capsuleHalfHeight: 0.63,
    crouchHalfHeight: 0.315,
    mass: 120,
    modelScale: 1.323,
    feetOffset: 0.212
  },
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
  camera: {
    fov: 70,
    shoulderOffset: 0.35,
    shoulderOffsets: [0, 0.55, 0.35, 0.1, 0.0],
    headHeight: 1.85,
    zoomStages: [0, 2, 4, 8, 18],
    defaultZoomIndex: 2,
    followSpeed: 12.0,
    snapSpeed: 30.0,
    mouseSensitivity: 0.002,
    pitchRange: [-1.4, 1.4]
  },
  animation: {
    mixerTimeScale: 1.3,
    walkTimeScale: 2.4,
    jogTimeScale: 1.9,
    sprintTimeScale: 1.0,
    fadeTime: 0.15
  },
  trustedApps: ['matrix-construct-room', 'tps-game'],
  placeableApps: [],
  terrain: CONSTRUCT,
  entities: [
    { id: 'terrain', app: 'terrain', config: CONSTRUCT },
    { id: 'matrix-room', app: 'matrix-construct-room', position: [0, 0, 0] },
    { id: 'tps-game', position: [0, 0, 0], app: 'tps-game' }
  ],
  spawnPoint: [0, 2, 0],
  playerModel: './apps/tps-game/cleetus.vrm',
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
}