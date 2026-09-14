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
}

export default {
  port: 3003,
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
