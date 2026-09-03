// Throwaway world for the floating-origin-jitter-test-100km PRD row's live witness: terrain only,
// zero GLB map (avoids the unrelated aim_sillos.glb malformed-meshopt-buffer load issue), no game
// mode/tps-game app -- just enough to boot the client, get a live camera/sceneGraph/floatingOrigin,
// and drive a synthetic 100km-offset jitter test. Not wired into any placeableApps/game flow.
const TERRAIN = {
  enabled: true,
  anchorDir: [-0.641, 0.2558, 0.7237],
  radius: 63600,
  reliefScale: 0.001,
  maxLevel: 13,
  offsetY: 0,
  center: [0, 0],
  bakedHeightfield: '/apps/world/tps-game.hf',
  physics: { extent: 256, resolution: 2 },
  seed: 1337,
  // weather-particle-system-rain-snow-tiers first-slice live-witness: rain on by default in this
  // throwaway harness world so the particle system is trivially reachable for verification.
  // serverAuthoritative:true (weather-server-driven-state-and-multiplayer-sync follow-up) additionally
  // makes this a live-witness target for the server-pushed WEATHER_SYNC message, reusing this same
  // no-GLB/fast-boot harness world rather than tps-game's slow map-corpus prewarm.
  weather: { serverAuthoritative: true, type: 'rain', intensity: 1, particleCount: 3000 },
}

export default {
  port: 3099,
  tickRate: 64,
  entityTickRate: 15,
  gravity: [0, -18.0, 0],
  // relevanceRadius 0 = unbounded (every entity sent to every client every snapshot, matching this
  // world's own zero-gameplay/editor-test-harness scope) -- a finite radius (this file previously used
  // 200) filters state.entities around the LOCAL PLAYER's position, not the editor fly-cam's, so a
  // gizmo/inspector floating-origin test that flies the fly-cam far from spawn without also moving the
  // player never receives the far entity's snapshot at all and EntityLoader never creates its mesh --
  // found live while witnessing editor-inspector-gizmo-position-display-write-floating-origin.
  relevanceRadius: 0,
  physicsRadius: 30,
  physicsBodyBudget: 512,
  trustedApps: ['terrain'],
  placeableApps: [],
  terrain: TERRAIN,
  entities: [
    { id: 'terrain', app: 'terrain', config: TERRAIN },
  ],
  spawnPoint: [0, 15.3, 0],
}
