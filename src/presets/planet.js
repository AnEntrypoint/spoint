export default {
  trustedApps: ['terrain'],
  terrain: {
    enabled: true,
    anchorDir: [-0.641, 0.2558, 0.7237],
    radius: 63600,
    reliefScale: 0.001,
    maxLevel: 13,
    offsetY: 0,
    center: [0, 0],
    physics: { extent: 256, resolution: 2 },
    seed: 1337
  },
  entities: [{ id: 'terrain', app: 'terrain' }]
}
