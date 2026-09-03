// Guided tutorial/onboarding world: a flat arena teaching core movement + interaction mechanics.
// Uses checkpoint-marker entities for progression gates (author them in the editor) and a tutorial
// orchestrator app (apps/tutorial/index.js) that walks the player through each step with HUD prompts.
// Terrain is disabled so the player starts on a clean flat plane; the tutorial app handles the
// progression sequence server-side.
export default {
  port: 3001,
  tickRate: 64,
  entityTickRate: 15,
  gravity: [0, -18.0, 0],
  relevanceRadius: 200,
  physicsRadius: 30,
  physicsBodyBudget: 256,
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
    fogNear: 500,
    fogFar: 2000,
    ambientColor: 0xfff4d6,
    ambientIntensity: 0.5,
    sunColor: 0xffffff,
    sunIntensity: 1.5,
    sunPosition: [21, 50, 20],
    fillColor: 0x4488ff,
    fillIntensity: 0.3,
    fillPosition: [-20, 30, -10],
    shadowMapSize: 1024,
    shadowBias: 0.0038,
    shadowNormalBias: 0.6
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
  trustedApps: [],
  placeableApps: ['checkpoint-marker', 'trigger-volume', 'button', 'spawn-point', 'respawn-zone'],
  // No terrain — flat arena for the tutorial so the player can focus on learning controls.
  terrain: { enabled: false },
  entities: [
    { id: 'tutorial-app', position: [0, 0, 0], app: 'tutorial' },
    // Movement checkpoints: a linear sequence the player walks through. Each checkpoint-marker
    // entity carries a custom._tutorialStep tag (order 0 = WASD walk, 1 = sprint, 2 = jump, 3 = interact).
    // The tutorial app reads these at first update tick via ctx.world.query and builds the progression.
    { id: 'tut-step-wasd',     position: [0, 1, 3], app: 'checkpoint-marker', config: { order: 0, radius: 3, color: '#33ccff' } },
    { id: 'tut-step-sprint',   position: [0, 1, 9], app: 'checkpoint-marker', config: { order: 1, radius: 3, color: '#33ccff' } },
    { id: 'tut-step-jump',     position: [0, 1, 15], app: 'checkpoint-marker', config: { order: 2, radius: 3, color: '#33ccff' } },
    // A button at the end to teach interaction (E key). The button app sends a message when
    // interacted with; the tutorial app listens for it as the final step.
    { id: 'tut-button', position: [0, 1, 21], app: 'button', config: { target: 'tutorial-app', channel: 'tutorial.finish', prompt: 'Press E to interact' } },
    // A respawn zone at the spawn point so the player always returns there.
    { id: 'tut-respawn', position: [0, 0.5, 0], app: 'respawn-zone', config: { radius: 5 } },
  ],
  spawnPoint: [0, 1.5, 0],
  playerModel: './apps/tps-game/cleetus.vrm',
}