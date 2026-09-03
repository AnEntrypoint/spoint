// Minimal flat-floor arena for the spointreplay-file-format-deterministic-playback record/playback
// live witness (scripts/replay-record-and-play.mjs). Same box-static-floor pattern as
// apps/world/playtest-heatmap-harness.js/sillos-isolated.js -- no terrain streaming, no vegetation,
// nothing that could introduce async-load timing differences between the record run and the playback
// run; the whole point of this world is to isolate the replay mechanism's own determinism from
// terrain-streaming's (a separate, larger PRD row: deterministic-simulation-jolt-fixed-point-rollback).
export default {
  port: 3098,
  tickRate: 60,
  gravity: [0, -9.81, 0],
  spawnPoint: [0, 5, 0],
  entities: [
    { id: 'floor', app: 'box-static', position: [0, -1, 0], config: { hx: 60, hy: 1, hz: 60 } },
  ],
}
