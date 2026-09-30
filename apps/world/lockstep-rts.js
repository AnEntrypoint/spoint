const ARENA = 18
const SQUADS = 2
const UNITS_PER_SQUAD = 12
const SQUAD_COLORS = ['#3a7bd5', '#d5533a']

const units = []
for (let q = 0; q < SQUADS; q++) {
  for (let k = 0; k < UNITS_PER_SQUAD; k++) {
    units.push({ id: `unit-${q}-${k}`, app: 'rts-unit', position: [0, 0.35, 0], config: { color: SQUAD_COLORS[q], size: 0.7 } })
  }
}

export default {
  name: 'lockstep-rts',
  tickRate: 30,
  gravity: [0, -9.81, 0],
  spawnPoints: [[-ARENA * 0.75, 1.2, 4], [ARENA * 0.75, 1.2, 4]],
  netcode: {
    profile: 'lockstep',
    peers: 2,
    lockstep: { inputDelayTicks: 3, checksumIntervalTicks: 30, stallTicks: 300, maxCatchUpTicks: 4 }
  },
  entities: [
    { id: 'floor', app: 'box-static', position: [0, -1, 0], config: { hx: ARENA, hy: 1, hz: ARENA, color: '#5b6b4a' } },
    { id: 'wall-n', app: 'box-static', position: [0, 1, -ARENA - 0.5], config: { hx: ARENA + 1, hy: 1, hz: 0.5, color: '#44503a' } },
    { id: 'wall-s', app: 'box-static', position: [0, 1, ARENA + 0.5], config: { hx: ARENA + 1, hy: 1, hz: 0.5, color: '#44503a' } },
    { id: 'wall-w', app: 'box-static', position: [-ARENA - 0.5, 1, 0], config: { hx: 0.5, hy: 1, hz: ARENA, color: '#44503a' } },
    { id: 'wall-e', app: 'box-static', position: [ARENA + 0.5, 1, 0], config: { hx: 0.5, hy: 1, hz: ARENA, color: '#44503a' } },
    { id: 'rts-controller', app: 'lockstep-rts', position: [0, 0, 0], config: { squads: SQUADS, unitsPerSquad: UNITS_PER_SQUAD, arena: ARENA } },
    ...units
  ]
}
