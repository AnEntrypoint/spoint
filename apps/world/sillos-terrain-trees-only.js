// Isolation harness step 5: sillos + terrain + TREES only (rocks disabled), splitting
// "vegetation/rocks" (step 3, reproduced) the other way from sillos-terrain-rocks-only.
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
  vegetation: {
    enabled: true, seed: 1337, renderDistance: 640, treeline: 4000, densityScale: 1.0, maxInstances: 30000, sharedImpostor: true,
    species: ['Oak Large', 'Pine Medium', 'Aspen Medium', 'Ash Medium', 'Bush', 'Ash Small', 'Ash Large', 'Aspen Small', 'Aspen Large', 'Bush 2', 'Bush 3', 'Oak Small', 'Oak Medium', 'Pine Small', 'Pine Large'],
    colliders: true, colliderRadius: 64, colliderCap: 384,
    rocks: false, rockRenderDistance: 320, rockMaxInstances: 12000,
    rockColliders: false, rockColliderRadius: 32, rockColliderCap: 128
  }
}

export default {
  port: 3006,
  tickRate: 64,
  entityTickRate: 15,
  gravity: [0, -18.0, 0],
  spawnPoint: [0, 15.3, 0],
  trustedApps: ['terrain'],
  placeableApps: [],
  terrain: TERRAIN,
  entities: [
    { id: 'terrain', app: 'terrain', config: TERRAIN },
    { id: 'env-sillos', model: './apps/maps/aim_sillos.glb', position: [0, 10.31, 0], scale: [1, 1, 1], app: 'placed-model', config: { collider: 'trimesh' }, custom: { _interior: true } },
  ],
}
