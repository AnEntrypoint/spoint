---
key: mem-e5cba6462dddb5d9-1324
ns: default
created: 1790786000897
updated: 1790786000897
---

project/tsl-terrain-sun-flag-and-boot-race-2026-09-30: In three r185 material.needsUpdate does NOT rebuild a node material whose cache key is unchanged, so a JS build-time branch on 'is this light the sun' can freeze wrong forever; terrain-lighting-tsl builds the sun term for every DirectionalLight except ShadowPipeline cascades (name prefix shadowCascade, they would add dead PCF lookups) and multiplies it by a per-light uniform(0).onRenderUpdate(light === sunRef.light) flag (RENDER update type, once per renderId). client/app.js terrain builds: rebuildTerrain newest-wins via _terrainBuildGen, a seed change sets _terrainReseedPending which only the winning build consumes (so reseed then a quick plain rebuild still recreates foliage); boot builds first-healthy-wins: a later boot build disposes itself unless the live backdrop is the planet-less fallback (no registerDebugGlobals), and returns without duplicate setup when _bootSceneryStarted. Parity at coast pose AMD: tod 0.3/0.4/0.55 TSL sand 181-183,161-163,109 vs legacy 180,161,108-109 (terrain lighting ignores time of day in BOTH paths: TerrainBackdrop sunLocal is fixed at boot, pre-existing). NVIDIA WebGPU 180,160,108 (NVIDIA 3D engine ~96-102% busy from another project's headless Chrome; load took 87-337 s; teleports time out, use window.__tpOverride).
