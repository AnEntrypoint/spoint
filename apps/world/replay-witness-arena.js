export default {
  port: 3098,
  tickRate: 60,
  gravity: [0, -9.81, 0],
  spawnPoint: [0, 5, 0],
  entities: [
    { id: 'floor', app: 'box-static', position: [0, -1, 0], config: { hx: 60, hy: 1, hz: 60 } },
  ],
}
