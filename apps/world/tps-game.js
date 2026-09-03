const TERRAIN = {
  enabled: true,
  anchorDir: [-0.641, 0.2558, 0.7237],
  radius: 63600,
  reliefScale: 0.001,
  maxLevel: 13,
  offsetY: 0,
  center: [0, 0],
  // re-bake bakedHeightfield (scripts/bake-heightfield.mjs) when terrain.glsl/anchorDir/radius/reliefScale/seed change, else collider desyncs from the visible surface
  bakedHeightfield: '/apps/world/tps-game.hf',
  physics: { extent: 256, resolution: 2 },
  seed: 1337,
  // server-clock-synced-time-of-day-network-sync: this world is the real multiplayer test target (port
  // 3001, the WS server path), so it opts into the server-authoritative day-cycle clock -- every connected
  // client's TimeOfDay.js stays periodically corrected to the SAME server-ticked fraction instead of each
  // running an independent free-running local clock that drifts apart between players. dayLengthSec/
  // startFraction here are read on BOTH sides (server's ServerTimeOfDay + client's local TimeOfDay), so
  // they stay a single source of truth. Singleplayer (WorkerEntry.js's in-Worker boot of this same world
  // def) also reads serverAuthoritative, but with no other client to sync to it's a no-op there in
  // practice -- the local clock behaves identically to before this feature.
  // AAA-push cross-piece regression (found live, round 5-7 of the open-landscape piece): startFraction
  // was bumped 0.3->0.27 by the low-sun/golden-hour piece's own round 3 so the world would boot AT
  // that piece's target lighting for easy iteration -- but this is the WORLD'S shared default time,
  // so every OTHER piece (open-landscape-midday included) got tested against golden-hour lighting by
  // accident. Reverting to 0.3 wasn't actually a fix either: client/core/TimeOfDay.js's own
  // _elevationDeg(frac)=sin((frac-0.25)*2pi)*(90-tilt) peaks at frac=0.5 (true solar noon) -- 0.3 is
  // only ~18deg elevation (its own comment even says "0.3 ~ mid-morning", never claimed to be
  // midday). Using 0.5 for genuine midday/high-sun testing; per-piece lighting states still belong
  // in each piece's own test setup for pieces that need a DIFFERENT angle (e.g. low-sun), never in
  // this shared world config that every piece's test otherwise inherits.
  timeOfDay: { serverAuthoritative: true, dayLengthSec: 600, startFraction: 0.5 },
  // weather-server-driven-state-and-multiplayer-sync: same real-multiplayer-test-world rationale as
  // timeOfDay.serverAuthoritative immediately above -- every connected client's weather state
  // (client/core/Weather.js) stays a server-pushed value (src/sdk/ServerWeather.js, MSG.WEATHER_SYNC)
  // instead of each client only ever reading this static block once at world-scenery-build time. type/
  // intensity here are the STARTING state (both server-side ServerWeather.js's first-activation seed and
  // client-side _ensureWeather's pre-sync initial value), matching timeOfDay's own
  // dayLengthSec/startFraction dual-read discipline.
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
  // Hard activation rings (AppRuntimePhysics.js _tickPhysicsLOD): <physicsRadius = fully physical,
  // physicsRadius..physicsRadius*(100/30) = kinematic-frozen, beyond = data-only (no Jolt body).
  // 30m keeps the physical ring tight for a 30k-model scene; the vast majority of dynamic props sit
  // in the kinematic or data-only ring at any moment and cost near-zero physics.step() time.
  physicsRadius: 30,
  // Global active-Jolt-body cap (proximity-priority sleep, farthest-first) -- see _enforceBodyBudget.
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
    // shadowRadius/shadowBlurSamples are read only by three.js's VSM blur pass
    // (WebGLShadowMap.js postProcessShadowMap, gated on shadow.type===VSMShadowMap);
    // client/core/SceneSetup.js hardcodes renderer.shadowMap.type=PCFShadowMap, so
    // these two values are currently inert (no cost, no effect). Kept as a pre-tuned
    // starting point for a deliberate future PCFShadowMap->VSMShadowMap switch.
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
  // legacy compat alias; new code reads the terrain app's own config, not this key
  terrain: TERRAIN,
  entities: [
    { id: 'terrain', app: 'terrain', config: TERRAIN },
    // Y +10.31 = groundAtOrigin(-0.73) - localFloorBelowOrigin(-11.04) -- must re-derive after any render-scale change, a stale value buries the arena under terrain
    { id: 'env-sillos', model: './apps/maps/aim_sillos.glb', position: [0, 10.31, 0], scale: [1, 1, 1], app: 'placed-model', config: { collider: 'trimesh' }, custom: { _interior: true } },
    { id: 'spawn-sillos-1', position: [-15, 2.27, -10], app: 'spawn-point', config: { team: 'any' } },
    { id: 'spawn-sillos-2', position: [15, 2.27, -10], app: 'spawn-point', config: { team: 'any' } },
    { id: 'spawn-sillos-3', position: [-15, 2.27, -35], app: 'spawn-point', config: { team: 'any' } },
    { id: 'spawn-sillos-4', position: [15, 2.27, -35], app: 'spawn-point', config: { team: 'any' } },
    { id: 'tps-game', position: [0, 0, 0], app: 'tps-game' }
  ],
  spawnPoint: [-15, 2.27, -10],
  playerModel: './apps/tps-game/cleetus.vrm',
  // Overrides wireweave's bundled default public STUN/TURN list (node_modules/wireweave/src/data.js
  // DEFAULT_ICE_SERVERS, which ships shared openrelayproject demo TURN credentials) for the P2P
  // host/join bridge (client/WireweaveBridge.js createWireweaveBridge, client/hud/PeerHostUI.js,
  // client/BrowserServer.js addPeer). RTCIceServer[] shape: { urls: string|string[], username?, credential? }.
  // A real deployment should replace the TURN entry below with its own relay -- this one is only a
  // documented, working example matching wireweave's own bundled default entry.
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
}
