export default {
  presets: ['tps'],
  port: 3011,
  tickRate: 30,
  entities: [
    { id: 'static-model-corrupt', model: './apps/world/_fixtures/witness-corrupt-static.glb', position: [0, 0, 0], scale: [1, 1, 1], app: 'placed-model' },
  ],
}
