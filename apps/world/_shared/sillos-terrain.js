const SPECIES = ['Oak Large', 'Pine Medium', 'Aspen Medium', 'Ash Medium', 'Bush', 'Ash Small', 'Ash Large', 'Aspen Small', 'Aspen Large', 'Bush 2', 'Bush 3', 'Oak Small', 'Oak Medium', 'Pine Small', 'Pine Large']

export function sillosVegetation({ trees, rocks }) {
  return {
    enabled: true, seed: 1337, renderDistance: 640, treeline: 4000, densityScale: trees ? 1.0 : 0, maxInstances: 30000, sharedImpostor: true,
    species: trees ? SPECIES : [],
    colliders: trees, colliderRadius: 64, colliderCap: 384,
    rocks, rockRenderDistance: 320, rockMaxInstances: 12000,
    rockColliders: rocks, rockColliderRadius: 32, rockColliderCap: 128
  }
}

export function sillosTerrainWorld({ port, vegetation = null }) {
  return {
    presets: ['planet'],
    port,
    tickRate: 64,
    entityTickRate: 15,
    gravity: [0, -18.0, 0],
    spawnPoint: [0, 15.3, 0],
    placeableApps: [],
    terrain: { bakedHeightfield: '/apps/world/tps-game.hf', ...(vegetation ? { vegetation } : {}) },
    entities: [
      { id: 'env-sillos', model: './apps/maps/aim_sillos.glb', position: [0, 10.31, 0], scale: [1, 1, 1], app: 'placed-model', config: { collider: 'trimesh' }, custom: { _interior: true } }
    ]
  }
}
