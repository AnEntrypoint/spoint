export default {
  port: 8080,
  tickRate: 128,
  gravity: [0, -9.81, 0],
  movement: {
    maxSpeed: 4.0,
    groundAccel: 10.0,
    airAccel: 1.0,
    friction: 6.0,
    stopSpeed: 2.0,
    jumpImpulse: 4.0
  },
  entities: [
    { id: 'environment', model: './apps/tps-game/schwust.glb', position: [0, 0, 0], app: 'environment' },
    { id: 'game', position: [0, 0, 0], app: 'tps-game' },
    { id: 'power-crates', position: [0, 0, 0], app: 'power-crate' }
  ],
  playerModel: './apps/tps-game/Cleetus.vrm',
  spawnPoint: [-35, 3, -65]
}
