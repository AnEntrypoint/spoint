export default {
  spawnPoint: [0, 5, 0],
  gravity: [0, -9.81, 0],
  entities: [
    { id: 'match', app: 'fsm-arena', position: [0, 0, 0] },

    { id: 'arena-floor', app: 'floor', position: [0, -0.5, 0], config: { width: 60, depth: 60, thickness: 1, color: '#556677' } },

    { id: 'safety-net', app: 'respawn-zone', position: [0, 5, 0], config: { minY: -20, respawn: [0, 5, 0] } },

    { id: 'spawn-a', app: 'spawn-point', position: [10, 1, 10] },
    { id: 'spawn-b', app: 'spawn-point', position: [-10, 1, 10] },
    { id: 'spawn-c', app: 'spawn-point', position: [10, 1, -10] },
    { id: 'spawn-d', app: 'spawn-point', position: [-10, 1, -10] },

    { id: 'bot-1', app: 'combat-bot', position: [15, 1, 0], config: { health: 100, damage: 15, fireRateMs: 400, range: 60, aggro: 80, color: '#dd3344' } },
    { id: 'bot-2', app: 'combat-bot', position: [-15, 1, 0], config: { health: 100, damage: 15, fireRateMs: 400, range: 60, aggro: 80, color: '#dd6633' } },
    { id: 'bot-3', app: 'combat-bot', position: [0, 1, 15], config: { health: 150, damage: 20, fireRateMs: 300, range: 70, aggro: 100, color: '#aa2266' } },
  ]
}
