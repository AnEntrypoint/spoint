// Lightweight boot-fast test world (no terrain) for live-witnessing the server-authoritative inventory
// validation slice: WORLD=inventory-test PORT=<n> node server.js. The item-pickup entity sits ON the
// world spawn point (within its own pickup radius) so a real joining WS client is server-authoritatively
// inside collection range from its very first tick -- a genuine "player position enters the pickup's
// server-computed overlap radius" collection, not a forged/teleported position, and deterministic without
// needing to drive real movement-input physics for this harness. respawnMs is set far beyond this
// harness's own runtime (a stationary player sitting inside the radius would otherwise re-collect every
// cooldown window, changing the gold count non-deterministically mid-test) -- respawn/re-collection
// itself is real, intended definePickup behavior, just not what THIS determinism-sensitive test wants.
export default {
  port: 3099,
  tickRate: 30,
  gravity: [0, -18.0, 0],
  spawnPoint: [0, 2, 0],
  placeableApps: ['item-pickup'],
  entities: [
    { id: 'gold-pickup-1', app: 'item-pickup', position: [0, 2, 0], config: { item: 'gold', amount: 10, radius: 2.5, respawnMs: 600000, poolId: 'default' } },
    // maxStack=5 for medkit (apps/_lib/item-definitions.js) but this legitimate grant asks for 8 -- proves
    // add()'s real maxStack clamp fires on a REAL server-computed grant, not just that a forged mutation is inert.
    { id: 'medkit-pickup-1', app: 'item-pickup', position: [0, 2, 0], config: { item: 'medkit', amount: 8, radius: 2.5, respawnMs: 600000, poolId: 'default' } },
  ],
}
