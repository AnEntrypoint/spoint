// Deliberate real-stuck-detection test world: encloses a playtest-bot in a sealed box of real static
// colliders (box-static, floor+ceiling+4 walls) so it has NO possible escape path. Used to verify the
// stuck-finding actually fires against a genuinely wedged bot, not just the false-positive-elimination
// verified separately in the open sandbox world. Boot with: WORLD=playtest-bot-trap-test node server.js
// Temporary verification world for this session's task -- not part of any placeable-game world, left in
// the repo as a reusable manual-verification fixture for this app (same spirit as apps/world/sandbox.js).
const WALL_T = 0.5   // wall half-thickness
const R = 3           // half-extent of the interior box (6m x 6m x 6m room)

export default {
  spawnPoint: [0, 2, 0],
  gravity: [0, -9.81, 0],
  entities: [
    { id: 'floor', app: 'box-static', position: [0, -WALL_T, 0], config: { hx: R + WALL_T, hy: WALL_T, hz: R + WALL_T, color: '#555555' } },
    { id: 'ceiling', app: 'box-static', position: [0, R * 2 + WALL_T, 0], config: { hx: R + WALL_T, hy: WALL_T, hz: R + WALL_T, color: '#555555' } },
    { id: 'wall-north', app: 'box-static', position: [0, R, R + WALL_T], config: { hx: R + WALL_T, hy: R, hz: WALL_T, color: '#775555' } },
    { id: 'wall-south', app: 'box-static', position: [0, R, -R - WALL_T], config: { hx: R + WALL_T, hy: R, hz: WALL_T, color: '#775555' } },
    { id: 'wall-east', app: 'box-static', position: [R + WALL_T, R, 0], config: { hx: WALL_T, hy: R, hz: R + WALL_T, color: '#557755' } },
    { id: 'wall-west', app: 'box-static', position: [-R - WALL_T, R, 0], config: { hx: WALL_T, hy: R, hz: R + WALL_T, color: '#557755' } },
    // Bot placed dead-center. wanderRadius is deliberately larger than the room so every random-walk
    // target the bot picks lies OUTSIDE the walls -- it will always be walking straight into a wall it
    // cannot pass, the real "no possible escape" condition this test exists to exercise. stuckTicks
    // lowered so the test resolves in a few seconds of real wall-clock time instead of minutes.
    { id: 'trapped-bot', app: 'playtest-bot', position: [0, 1, 0], config: { wanderRadius: 20, stuckTicks: 15, speed: 3 } },
  ],
}
