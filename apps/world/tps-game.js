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
  timeOfDay: { serverAuthoritative: true, dayLengthSec: 600, startFraction: 0.5 },
  weather: { serverAuthoritative: true, type: 'rain', intensity: 0.6, particleCount: 3000 },
  vegetation: {
    enabled: true, seed: 1337, renderDistance: 640, treeline: 4000, densityScale: 1.0, maxInstances: 30000, sharedImpostor: true,
    species: ['Oak Large', 'Pine Medium', 'Aspen Medium', 'Ash Medium', 'Bush', 'Ash Small', 'Ash Large', 'Aspen Small', 'Aspen Large', 'Bush 2', 'Bush 3', 'Oak Small', 'Oak Medium', 'Pine Small', 'Pine Large'],
    colliders: true, colliderRadius: 64, colliderCap: 384,
    rocks: true, rockRenderDistance: 320, rockMaxInstances: 12000,
    rockColliders: true, rockColliderRadius: 32, rockColliderCap: 128
  }
}

export default {
  port: 3001,
  tickRate: 64,
  entityTickRate: 15,
  gravity: [0, -18.0, 0],
  relevanceRadius: 200,
  physicsRadius: 30,
  physicsBodyBudget: 512,
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
    skyColor: 0xff9a5c,
    fogColor: 0xffb389,
    fogNear: 10000,
    fogFar: 20000,
    ambientColor: 0xffcf9e,
    ambientIntensity: 0.55,
    sunColor: 0xffa552,
    sunIntensity: 1.8,
    sunPosition: [65, 8, 20],
    fillColor: 0xff5f8e,
    fillIntensity: 0.6,
    fillPosition: [-65, 14, -20],
    shadowMapSize: 1024,
    shadowBias: -0.0005,
    shadowNormalBias: 0.05,
    shadowRadius: 12,
    shadowBlurSamples: 8
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
  trustedApps: ['terrain'],
  placeableApps: ['destructible-box', 'destructible-debris', 'box-dynamic', 'box-static', 'box-buoyant', 'button', 'trigger-volume', 'spawn-point', 'weapon-spawn', 'respawn-zone', 'collectible', 'pickup', 'moving-platform', 'capture-zone', 'waypoint', 'shrinking-zone', 'playtest-bot', 'vehicle', 'tank', 'softbody-cloth', 'fluid-source', 'fluid3d-source'],
  terrain: TERRAIN,
  entities: [
    { id: 'terrain', app: 'terrain', config: TERRAIN },
    { id: 'env-sillos', model: './apps/maps/aim_sillos.glb', position: [0, 10.31, 0], scale: [1, 1, 1], app: 'placed-model', config: { collider: 'trimesh' }, custom: { _interior: true } },
    { id: 'spawn-sillos-1', position: [-15, 2.27, -10], app: 'spawn-point', config: { team: 'any' } },
    { id: 'spawn-sillos-2', position: [15, 2.27, -10], app: 'spawn-point', config: { team: 'any' } },
    { id: 'spawn-sillos-3', position: [-15, 2.27, -35], app: 'spawn-point', config: { team: 'any' } },
    { id: 'spawn-sillos-4', position: [15, 2.27, -35], app: 'spawn-point', config: { team: 'any' } },
    { id: 'tps-game', position: [0, 0, 0], app: 'tps-game' }
  ],
  spawnPoint: [-15, 2.27, -10],
  playerModel: './apps/tps-game/cleetus.vrm',
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
}
