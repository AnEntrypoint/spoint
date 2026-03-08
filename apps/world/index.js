import { getPropScale, PROP_MODELS } from './prop-scales.js'

const MAP_X_MIN = -250
const MAP_X_MAX = 250
const MAP_Z_MIN = -250
const MAP_Z_MAX = 250
const SPAWN_Y = 3
const TARGET_COUNT = 100

const MAP_W = MAP_X_MAX - MAP_X_MIN
const MAP_D = MAP_Z_MAX - MAP_Z_MIN
const GRID_COLS = Math.ceil(Math.sqrt(TARGET_COUNT * (MAP_W / MAP_D)))
const GRID_ROWS = Math.ceil(TARGET_COUNT / GRID_COLS)
const SPACING_X = MAP_W / (GRID_COLS - 1)
const SPACING_Z = MAP_D / (GRID_ROWS - 1)

const dynEntities = []
for (let i = 0; i < TARGET_COUNT; i++) {
  const row = Math.floor(i / GRID_COLS)
  const col = i % GRID_COLS
  const modelFile = PROP_MODELS[i % PROP_MODELS.length]
  const s = getPropScale(modelFile)
  dynEntities.push({
    id: `dyn-${i}`,
    model: `./apps/props/dynamic/${modelFile}`,
    position: [MAP_X_MIN + col * SPACING_X, SPAWN_Y, MAP_Z_MIN + row * SPACING_Z],
    scale: [s, s, s],
    app: 'prop-dynamic',
  })
}

export default {
  port: 3001,
  tickRate: 64,
  entityTickRate: 15,
  gravity: [0, -9.81, 0],
  relevanceRadius: 60,
  physicsRadius: 60,
  movement: {
    maxSpeed: 11.0,
    groundAccel: 150.0,
    airAccel: 1.0,
    friction: 5.0,
    stopSpeed: 1.5,
    jumpImpulse: 3.6,
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
    headHeight: 0.85,
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
    { id: 'env-sillos', model: './apps/maps/aim_sillos.glb', position: [0, 0, 0], app: 'environment' },
    { id: 'webcam1', position: [0, SPAWN_Y, -5], app: 'webcam-avatar' },
    ...dynEntities,
  ],
  spawnPoints: [
    [-26, -0.67, -47],
    [-21.5, -1.42, -47],
    [-15.5, -1.42, -47],
    [-11, -2.14, -47],
    [-6.5, -5.26, -47],
    [4, -1.9, -50],
    [8.5, -1.9, -50],
    [14.5, -1.9, -48.5],
    [-26, -0.76, -44],
    [-21.5, -1.42, -44],
    [-15.5, -1.42, -44],
    [-11, -1.42, -44],
    [-6.5, -1.42, -44],
    [-0.5, -5.26, -44],
    [4, -6.74, -44],
    [8.5, -6.52, -44],
    [14.5, -1.9, -44],
    [22, -1.42, -35],
    [-26, -1.27, -35],
    [-21.5, -7.05, -35],
    [-15.5, -7.18, -35],
    [-11, -7.18, -35],
    [-6.5, -7.08, -35],
    [-0.5, -7.03, -35],
    [4, -1.42, -35],
    [8.5, -1.42, -35],
    [14.5, -1.42, -35],
    [19, -1.42, -35],
    [-26, -0.88, -26],
    [-21.5, -7.09, -26],
    [-15.5, -1.66, -26],
    [-11, -7.18, -26],
    [-6.5, -6.94, -26],
    [-0.5, -6.94, -26],
    [4, -6.94, -26],
    [8.5, -7.18, -26],
    [14.5, -6.14, -26],
    [19, -1.42, -26],
    [22, -1.42, -26],
    [-26, -0.6, -17],
    [-21.5, -1.9, -17],
    [-15.5, -7.18, -17],
    [-11, -7.18, -17],
    [-6.5, -4.06, -17],
    [-0.5, -4.06, -17],
    [4, -6.94, -17],
    [8.5, -7.18, -17],
    [14.5, -1.66, -17],
    [19, -2.05, -17],
    [22, -1.42, -17],
    [-26, -0.85, -8],
    [-21.5, -1.42, -8],
    [-15.5, -1.42, -8],
    [-11, -1.42, -8],
    [-6.5, -7.18, -8],
    [-0.5, -7.18, -8],
    [4, -7.18, -8],
    [8.5, -7.18, -8],
    [14.5, -5.26, -8],
    [19, -6.46, -8],
    [22, -1.9, -8],
    [-26, -0.52, -2],
    [-17, -1.9, 1],
    [-11, -7.18, 1],
    [-6.5, -1.42, 1],
    [-0.5, -5.5, 1],
    [4, -1.42, 1],
    [8.5, -1.42, 1],
    [14.5, -7.18, 1],
    [19, -7, 1],
    [22, -1.9, 1],
    [-26, -0.67, -47],
    [-26, -0.71, -45.5],
    [-26, -0.76, -44],
    [-26, -0.8, -42.5],
    [-26, -0.85, -41],
    [-26, -0.89, -39.5]
  ],
  spawnPoint: [0, 1, 0],
  playerModel: './apps/tps-game/cleetus.vrm'
}
