// Deliberate real spawn-point LOS-gap test world: two spawn-point markers separated by a real solid
// wall (box-static) so ctx.canSee between them MUST be false -- verifies playtest-bot's spawn-LOS audit
// actually detects a real line-of-sight gap, not just "ran without crashing." A third spawn-point pair
// with clear sight (no wall between spawn-clear-a/b) confirms the audit does NOT false-positive on an
// open pair. Boot with: WORLD=playtest-bot-los-test node server.js
// Temporary verification world for this session's task, left as a reusable manual-verification fixture
// (same spirit as apps/world/sandbox.js).
export default {
  spawnPoint: [0, 2, 0],
  gravity: [0, -9.81, 0],
  entities: [
    // Blocked pair: spawn-blocked-a and spawn-blocked-b sit on opposite sides of a wall.
    { id: 'spawn-blocked-a', app: 'spawn-point', position: [-5, 1, 0] },
    { id: 'wall-between', app: 'box-static', position: [0, 2, 0], config: { hx: 0.5, hy: 3, hz: 5, color: '#996644' } },
    { id: 'spawn-blocked-b', app: 'spawn-point', position: [5, 1, 0] },
    // Clear pair: no geometry between them at all.
    { id: 'spawn-clear-a', app: 'spawn-point', position: [-5, 1, 20] },
    { id: 'spawn-clear-b', app: 'spawn-point', position: [5, 1, 20] },
    // The bot itself just needs to exist to run the audit; placed off to the side so its own wander
    // doesn't interfere with reading the spawn-LOS log output.
    { id: 'los-test-bot', app: 'playtest-bot', position: [0, 1, 40], config: { wanderRadius: 5, checkSpawnLOS: true } },
  ],
}
