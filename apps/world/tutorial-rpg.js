export default {
  port: 3001,
  tickRate: 30,
  gravity: [0, -9.81, 0],

  movement: {
    maxSpeed: 5.0,
    groundAccel: 15.0,
    airAccel: 2.0,
    friction: 8.0,
    stopSpeed: 1.0,
    jumpImpulse: 5.0
  },

  player: {
    health: 100,
    capsuleRadius: 0.4,
    capsuleHalfHeight: 0.9,
    modelScale: 1.323,
    feetOffset: 0.212
  },

  scene: {
    skyColor: 0x87ceeb,
    fogColor: 0xb0c4de,
    fogNear: 100,
    fogFar: 300,
    ambientColor: 0xffffff,
    ambientIntensity: 0.5,
    sunColor: 0xffffff,
    sunIntensity: 1.2,
    sunPosition: [30, 50, 30],
    shadowMapSize: 1024,
    shadowBias: 0.0038,
    shadowNormalBias: 0.6
  },

  entities: [
    {
      id: 'arena-floor',
      position: [0, 0, 0],
      app: 'box-static',
      config: { hx: 50, hy: 0.5, hz: 50, color: 0x2d5016 }
    },
    {
      id: 'arena-wall-north',
      position: [0, 5, -50],
      app: 'box-static',
      config: { hx: 50, hy: 5, hz: 1, color: 0x444444 }
    },
    {
      id: 'arena-wall-south',
      position: [0, 5, 50],
      app: 'box-static',
      config: { hx: 50, hy: 5, hz: 1, color: 0x444444 }
    },
    {
      id: 'arena-wall-west',
      position: [-50, 5, 0],
      app: 'box-static',
      config: { hx: 1, hy: 5, hz: 50, color: 0x444444 }
    },
    {
      id: 'arena-wall-east',
      position: [50, 5, 0],
      app: 'box-static',
      config: { hx: 1, hy: 5, hz: 50, color: 0x444444 }
    },
    {
      id: 'tower-base',
      position: [0, 1, 0],
      app: 'tower',
      config: {}
    }
  ],

  spawnPoint: [0, 2, 25]
}
