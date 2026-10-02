---
key: mem-4cfc9f942a4f1cbc-1039
ns: default
created: 1790957307004
updated: 1790957307004
---

MEASURED (2026-10-02), refutes the 'unbudgeted initial collider ring stalls boot' hypothesis. Instrumenting src/terrain/ColliderStreamer.js start() around _rebuildMulti(centers,true) over four real WORLD=tps-game node server.js boots: veg ring 49.9-75.6 ms (66/384 colliders, 42 chunks, 1 center, radius 64/keep 70.4 m), rocks ring 7.5-14.5 ms (17 chunks, radius 32). Total 61-90 ms. Boot always has 1 center (getCenters falls back to tcfg.center with no players). The real boot cost in the same setupTerrainStreaming call is HeightfieldStreamer.start(): coarse N=32/256 m in 113-238 ms then N=128 spacing 2.02 m in 1049-1283 ms of sampling, awaited at TerrainPhysics.js:167 before world-ready; plus rock pool prewarm 240-327 ms (540 mesh-hull bodies, RockPhysics.js:79) for a ring that ends with 0 rock colliders near the tps spawn. Filed as PRD row terrain-boot-awaits-full-heightfield-before-world-ready. Also: ColliderStreamer runs in the SDK worker in the browser, never the main thread, so it could never be a main-thread boot stall.
