export default {
  port: 3002,
  tickRate: 64,
  entityTickRate: 15,
  gravity: [0, -18.0, 0],
  spawnPoint: [0, 15.3, 0],
  placeableApps: [],
  entities: [
    { id: 'env-sillos', model: './apps/maps/aim_sillos.glb', position: [0, 10.31, 0], scale: [1, 1, 1], app: 'placed-model', config: { collider: 'trimesh' }, custom: { _interior: true } },
    { id: 'floor', app: 'box-static', position: [0, -20, 0], config: { hx: 200, hy: 1, hz: 200 } },
  ],
}
