// Minimal flat-floor arena for the playwright-e2e-plus-perf-gates-ci PRD row's CI E2E harness
// (scripts/e2e-ci.mjs). Same box-static-floor pattern as apps/world/replay-witness-arena.js /
// apps/world/playtest-heatmap-harness.js -- no terrain streaming, no vegetation, no map GLBs, so a
// cold CI checkout boots fast (SPOINT_SKIP_PREWARM=1 skips the whole-apps-tree GLB/VRM prewarm scan,
// which would otherwise still walk this tree looking for assets that don't exist here) and two real
// headless browser clients converge on deterministic, terrain-independent physics.
export default {
  port: 3099,
  tickRate: 60,
  gravity: [0, -9.81, 0],
  spawnPoint: [0, 5, 0],
  entities: [
    { id: 'floor', app: 'box-static', position: [0, -1, 0], config: { hx: 100, hy: 1, hz: 100 } },
  ],
}
