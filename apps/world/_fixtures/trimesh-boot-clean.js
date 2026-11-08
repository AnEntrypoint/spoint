export default {
  presets: ['tps'],
  port: 3012,
  tickRate: 30,
  entities: [
    { id: 'static-model-present', model: './node_modules/@dgreenheck/ez-tree/src/app/public/rock1.glb', position: [0, 0, 0], scale: [1, 1, 1], app: 'placed-model' },
  ],
}
