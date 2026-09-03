// VRM mirror-test scene (animation-vrm-spring-bone-lod-expression-wire). Boot with:
//   WORLD=vrm-mirror-test node server.js
// Purpose-built harness for live-witnessing (a) spring-bone LOD distance gating (window.__springBoneLodStats
// on the local client, plus a manual page.evaluate reposition of the remote-mirror avatar to cross the
// springBoneLodDist threshold) and (b) compact viseme/emote expression wire-code sync (drive the LOCAL
// player's expressionManager, e.g. window.__app.pm.setVRMExpression(window.__app.client.playerId,'happy',1),
// and read the SAME expression back off the REMOTE-rendered "mirror" avatar's own expressionManager to
// confirm the code round-tripped through the real server wire, not just a local mirror-object reference).
//
// No terrain (fast, deterministic boot -- this is a pure client/server VRM+netcode harness, not a
// rendering/terrain test), just a flat static ground box under the two players' feet so a real
// multiplayer session (2 real connected clients) can stand and look at each other without falling
// through. spawnPoint is a fixed "mirror stand" position; a second real browser session connecting to
// this same world (or a synthetic remote-mesh injected via pm.createPlayerVRM in a single session, for
// a one-tab live witness) becomes the "reflection" a few metres away, facing back.
export default {
  port: 3097,
  tickRate: 64,
  entityTickRate: 15,
  gravity: [0, -18.0, 0],
  relevanceRadius: 0,   // unbounded: both mirror-test participants must always see each other regardless of distance experiments
  physicsRadius: 30,
  physicsBodyBudget: 64,
  movement: {
    maxSpeed: 7.0, sprintSpeed: 12.0, groundAccel: 300.0, airAccel: 30.0,
    airMaxSpeed: 0.15, airSpeedCap: 16.0, friction: 5.0, stopSpeed: 1.0,
    jumpImpulse: 5.5, collisionRestitution: 0.2, collisionDamping: 0.25
  },
  player: {
    health: 100, capsuleRadius: 0.28, capsuleHalfHeight: 0.63, crouchHalfHeight: 0.315,
    mass: 120, modelScale: 1.323, feetOffset: 0.212
  },
  scene: {
    skyColor: 0x87ceeb, fogColor: 0x87ceeb, fogNear: 200, fogFar: 800,
    ambientColor: 0xfff4d6, ambientIntensity: 0.5,
    sunColor: 0xffffff, sunIntensity: 1.5, sunPosition: [21, 50, 20],
    fillColor: 0x4488ff, fillIntensity: 0.4, fillPosition: [-20, 30, -10],
    shadowMapSize: 1024, shadowBias: 0.0038, shadowNormalBias: 0.6, shadowRadius: 12, shadowBlurSamples: 8
  },
  camera: {
    fov: 70, shoulderOffset: 0.35, shoulderOffsets: [0, 0.55, 0.35, 0.1, 0.0],
    headHeight: 1.85, zoomStages: [0, 2, 4, 8, 18], defaultZoomIndex: 2,
    followSpeed: 12.0, snapSpeed: 30.0, mouseSensitivity: 0.002, pitchRange: [-1.4, 1.4]
  },
  animation: { mixerTimeScale: 1.3, walkTimeScale: 2.4, jogTimeScale: 1.9, sprintTimeScale: 1.0, fadeTime: 0.15 },
  trustedApps: [],
  placeableApps: ['box-static'],
  entities: [
    // Flat 60x60 ground plane (thin box) centered at the spawn stand.
    { id: 'mirror-ground', app: 'box-static', position: [0, -0.5, 0], config: { hx: 30, hy: 0.5, hz: 30, color: '#666677' } }
  ],
  spawnPoint: [0, 1, 0],
  playerModel: './apps/tps-game/cleetus.vrm'
}
