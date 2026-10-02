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
  presets: ['rts', 'arena'],
  arena: { size: ARENA, wallHeight: 2, floorColor: '#5b6b4a', wallColor: '#44503a' },
  spawnPoints: [[-ARENA * 0.75, 1.2, 4], [ARENA * 0.75, 1.2, 4]],
  netcode: {
    lockstep: { inputDelayTicks: 3, checksumIntervalTicks: 30, stallTicks: 300, maxCatchUpTicks: 4 }
  },
  entities: [
    { id: 'rts-controller', app: 'lockstep-rts', position: [0, 0, 0], config: { squads: SQUADS, unitsPerSquad: UNITS_PER_SQUAD, arena: ARENA } },
    ...units
  ]
}
