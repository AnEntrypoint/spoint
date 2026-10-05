---
key: mem-bbd4d4fc4d24d12e-1257
ns: default
created: 1791238468785
updated: 1791238468785
---

client/app.js _finishLoading used to await Promise.race([_buildWorldScenery(), setTimeout(SCENERY_BUILD_TIMEOUT_MS)]) and, when window.__terrain was still unset, dispose/null terrainBackdrop and call _buildWorldScenery() again. Promise.race does not cancel the loser, so the first build kept running inside createTerrainBackdrop while a second started -- the only guard was `if (!_terrainCfg || terrainBackdrop) return`, null during that window. Witnessed on headless SwiftShader by driving SCENERY_BUILD_TIMEOUT_MS down to 8000 ms: two boot:backdrop:start marks (two createTerrainBackdrop calls), both running to completion, and window.__terrain NULL at the moment boot gave up. Fixed by making _buildWorldScenery a joinable wrapper (returns the in-flight promise, clears the slot on settle) and by adopting the in-flight build for a second bounded window instead of restarting it; the drain-GL-errors/dispose/500 ms/re-attempt path now runs only when the previous build has genuinely SETTLED with no planet. After: one boot:backdrop:start, window.__terrain set when boot proceeds, no retry toast. Raising the cap does not fix this -- a cap measured from an arbitrary point is fragile by construction; joining is what makes losing the race non-destructive.
