// Deathrun/parkour world: apps/maps/deathrun_kosova.glb as the environment, apps/deathrun as the game
// mode (checkpoint-driven run timer + persistent per-map leaderboard), checkpoint-marker as the
// in-editor-placeable ordered start/finish/waypoint primitive. Mirrors apps/world/tps-game.js's shape
// (movement/player/scene/camera tuning copied from the same base since deathrun is still a first/third
// person mover on the same character controller -- only the game-mode entity + map differ).
export default {
  port: 3002,
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
  placeableApps: ['checkpoint-marker', 'trigger-volume', 'spawn-point', 'respawn-zone', 'moving-platform', 'waypoint'],
  entities: [
    // collider:'trimesh' + _interior mirrors apps/world/tps-game.js's env-sillos entry -- deathrun_kosova
    // is an enclosed corridor-run map, the same interior-DoubleSide-render + always-relevant-snapshot
    // treatment applies. Position/scale are the map's natural origin-placed authoring transform (no prior
    // render-scale bug history exists for this asset the way sillos had -- see AGENTS.md
    // placement-y-tuned-for-broken-scale caveat -- so no compensating offset is applied here).
    { id: 'env-deathrun-kosova', model: './apps/maps/deathrun_kosova.glb', position: [0, 0, 0], scale: [1, 1, 1], app: 'placed-model', config: { collider: 'trimesh' }, custom: { _interior: true } },
    { id: 'deathrun', position: [0, 0, 0], app: 'deathrun', config: { map: 'deathrun_kosova', minY: -50 } },
    // Two checkpoint-marker entities (order 0 = start, order 1 = finish) so the mode boots with a real,
    // in-world-editable course out of the box instead of only the code-level synthetic fallback in
    // apps/deathrun/index.js's setup(). A maker can add more via the editor's placeableApps entry to
    // build the real multi-stage deathrun course; these two are the minimum viable start/finish pair.
    // Positions verified LIVE via a real WebSocket-driven player walk (real physics/collision, not
    // guessed): spawn [0,15.3,0] settles to ground at [0,12.43,0]; straight-line +Z movement hits real
    // map geometry (a wall/gate) at z~11.2, but S then W/E reaches a long open corridor at y~12.43,
    // z~-7.4 spanning roughly x=-18 to x=17 -- checkpoint-1 sits at the real-reachable far end of that
    // corridor, confirmed traversable end-to-end by an actual driven run (see deathrun-live-server-boot-and-drive PRD row).
    { id: 'dr-checkpoint-0', app: 'checkpoint-marker', position: [0, 15, 0], config: { order: 0, radius: 5 } },
    { id: 'dr-checkpoint-1', app: 'checkpoint-marker', position: [17, 12.43, -7.4], config: { order: 1, radius: 5 } },
  ],
  spawnPoint: [0, 15.3, 0],
  playerModel: './apps/tps-game/cleetus.vrm',
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
}
