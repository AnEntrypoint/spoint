// Harness world for the automated-playtesting-bots-heatmap-and-balance-followup PRD row: a minimal
// flat-floor arena (same box-static-floor pattern as apps/world/sillos-isolated.js -- no terrain, no
// vegetation, nothing else that could slow down or complicate a short bounded real bot run) with
// several placed apps/weapon-spawn markers at varied distances from the bots' start position, plus
// two apps/playtest-bot instances so the balance/heatmap output is a real per-run aggregate across
// multiple bots, not just a single-bot trace. Driven by a standalone Node script
// (scripts/playtest-heatmap-run.mjs) that imports src/sdk/server.js's createServer/loadWorld directly
// (in-process, no HTTP listen needed) and ticks it for a bounded number of ticks.
export default {
  port: 3099,
  tickRate: 60,
  entityTickRate: 15,
  gravity: [0, -18.0, 0],
  spawnPoint: [0, 2, 0],
  placeableApps: ['weapon-spawn', 'playtest-bot', 'box-static'],
  entities: [
    // Large flat floor -- big enough that the bots' wanderRadius (40m below) never runs off the edge.
    { id: 'floor', app: 'box-static', position: [0, -1, 0], config: { hx: 120, hy: 1, hz: 120 } },
    // A perimeter wall ring so the random-walk fallback has real geometry to occasionally bump into
    // (exercises the existing collision-aware move / stuck-detection path too, not just open space).
    { id: 'wall-n', app: 'box-static', position: [0, 3, 100], config: { hx: 100, hy: 4, hz: 1 } },
    { id: 'wall-s', app: 'box-static', position: [0, 3, -100], config: { hx: 100, hy: 4, hz: 1 } },
    { id: 'wall-e', app: 'box-static', position: [100, 3, 0], config: { hx: 1, hy: 4, hz: 100 } },
    { id: 'wall-w', app: 'box-static', position: [-100, 3, 0], config: { hx: 1, hy: 4, hz: 100 } },
    // Six weapon-spawn markers at deliberately varied distances/positions from the bots' start (0,0)
    // so a real run produces a real spread of visit counts -- some close (over-visited-likely), some
    // far corners (under-visited-likely) -- rather than a symmetric layout that trivially balances.
    { id: 'wspawn-near', app: 'weapon-spawn', position: [5, 0.5, 0], config: { weaponType: 'pistol' } },
    { id: 'wspawn-mid-a', app: 'weapon-spawn', position: [30, 0.5, 20], config: { weaponType: 'rifle' } },
    { id: 'wspawn-mid-b', app: 'weapon-spawn', position: [-25, 0.5, -15], config: { weaponType: 'rifle' } },
    { id: 'wspawn-far-a', app: 'weapon-spawn', position: [80, 0.5, 80], config: { weaponType: 'sniper' } },
    { id: 'wspawn-far-b', app: 'weapon-spawn', position: [-80, 0.5, 70], config: { weaponType: 'shotgun' } },
    { id: 'wspawn-corner', app: 'weapon-spawn', position: [-90, 0.5, -90], config: { weaponType: 'launcher' } },
    // Two bots so the run's balance/heatmap data is a real multi-bot aggregate.
    { id: 'bot-1', app: 'playtest-bot', position: [0, 1, 0], config: { speed: 6, wanderRadius: 90, stuckTicks: 40, checkSpawnLOS: false } },
    { id: 'bot-2', app: 'playtest-bot', position: [10, 1, 10], config: { speed: 6, wanderRadius: 90, stuckTicks: 40, checkSpawnLOS: false } },
  ],
}
