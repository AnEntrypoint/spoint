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
  carves: [{ center: [0, -20], radius: 60, falloff: 40 }],
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
  presets: ['tps'],
  port: 3001,
  physicsBodyBudget: 512,
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
  trustedApps: ['terrain'],
  placeableApps: ['destructible-box', 'destructible-debris', 'box-dynamic', 'box-static', 'box-buoyant', 'button', 'trigger-volume', 'spawn-point', 'weapon-spawn', 'respawn-zone', 'collectible', 'pickup', 'moving-platform', 'capture-zone', 'waypoint', 'shrinking-zone', 'shrinking-zone-ring', 'playtest-bot', 'vehicle', 'tank', 'softbody-cloth', 'fluid-source', 'fluid3d-source'],
  terrain: TERRAIN,
  entities: [
    { id: 'terrain', app: 'terrain' },
    { id: 'env-sillos', model: './apps/maps/aim_sillos.glb', position: [0, 10.31, 0], scale: [1, 1, 1], app: 'placed-model', config: { collider: 'trimesh' }, custom: { _interior: true } },
    { id: 'spawn-sillos-1', position: [-15, 2.27, -10], app: 'spawn-point', config: { team: 'any' } },
    { id: 'spawn-sillos-2', position: [15, 2.27, -10], app: 'spawn-point', config: { team: 'any' } },
    { id: 'spawn-sillos-3', position: [-15, 2.27, -35], app: 'spawn-point', config: { team: 'any' } },
    { id: 'spawn-sillos-4', position: [15, 2.27, -33.5], app: 'spawn-point', config: { team: 'any' } },
    { id: 'tps-game', position: [0, 0, 0], app: 'tps-game' }
  ],
  spawnPoint: [-15, 2.27, -10]
}
