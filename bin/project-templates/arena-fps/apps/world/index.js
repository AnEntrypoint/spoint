// arena-fps template world-def: a flat static floor, a small ring of spawn points, three hostile
// combat-bots (server-driven hitscan AI, apps/combat-bot -- ships inside the spoint package itself,
// resolves from node_modules/spoint/apps/combat-bot with zero project-side copy needed, same as every
// other app referenced below), and an fsm-arena round-timer entity (apps/fsm-arena's
// lobby/countdown/round/end match FSM) so a fresh arena-fps project boots into an actually-playable
// free-for-all against bots instead of an empty box. Add more `combat-bot` entities or place
// `spawn-point` markers in the editor to grow the arena; see apps/README.md (copied from the spoint
// package) for the full apps/ convention.
export default {
  spawnPoint: [0, 5, 0],
  gravity: [0, -9.81, 0],
  entities: [
    { id: 'match', app: 'fsm-arena', position: [0, 0, 0] },

    // Flat static floor (apps/floor, template-local: a wide/thin static box collider).
    { id: 'arena-floor', app: 'floor', position: [0, -0.5, 0], config: { width: 60, depth: 60, thickness: 1, color: '#556677' } },

    // Fall-plane safety net (apps/respawn-zone, ships inside the spoint package itself): teleports a
    // player who somehow falls off/through the arena back to the world spawn instead of sitting at the
    // engine's own -100 kill-plane clamp indefinitely.
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
