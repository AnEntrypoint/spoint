# Cold boot and server internals: spoint

Scope: page load to playable (client), server boot to first tick (`src/sdk`), caches, and CLI-readable server probes. Every claim cites `path:line` read in this repo on 2026-10-18 (HEAD ba8850a). Lines are from the working tree; the gm index was 31 commits behind upstream when queried (see Gaps).

## Verification of the supplied numbers

| Claim | Result | Evidence |
|---|---|---|
| "[boot] world exists at 77369ms" | NOT FOUND as a measurement | The log format exists at `client/app.js:401` (`'[boot] world exists at ' + Math.round(_at) + 'ms -> readiness published (...)'`). The literal `77369` appears only in `.gm/prd.yml` as part of a `witness_dispatch_id` (`1791705050847-500-11e0349d20177369`). No recorded run in the repo carries that number. |
| "85692ms" | NOT FOUND as a boot measurement | `85692` matches only inside `.gm/witness-out/longtask-stack/longtask-stack-1791855994699.json` as part of a `"idle": 3355856928` field. |
| "[shader] warmup done, meshes: 10" | Format confirmed, the value 10 not in any recorded log | `client/core/SceneSetup.js:425` prints `'[shader] warmup done, meshes:', total, ...`. No log in the repo contains the `10` run. |
| Cold shader compile ~110 s on a source change | NOT FOUND | `110 seconds` returns zero hits. Scan flagged incomplete (see Gaps). |
| Cold shader compile ~150 s on d3d11/FXC | NOT FOUND | `150 seconds` returns zero hits. FXC is discussed in `client/core/RenderControls.js` and `client/core/MapspinnerWebGPUFeasibility.js` with no timing. |
| Only recorded cold-load number | `.cold-load-baseline.json` = `{"ms": 54552}` (written 2026-10-16 15:44) | Produced by `scripts/cold-load-gate.mjs`: navigation to `loadingMachine.isReady`. Gate fails above baseline x `THRESHOLD = 1.25` (`cold-load-gate.mjs:15`, `:128-132`). Clears `client/.glb-cache` first (`:36-41`). |

Conclusion: the 77 s and 86 s figures cannot be verified from the repo. The only recorded cold-load figure is 54.5 s, and it measures a different endpoint (`isReady`, not `world exists`). Any future run should record both marks: `performance.getEntriesByName('boot:world-exists')` (`app.js:382` marks it) and `loadingMachine.isReady`.

## Client cold path: what is serial and what already overlaps

Entry: `client/app.js:326` creates `loadingMachine`; `:686` subscribes and calls `_finishLoading()` when `inputsDone`.

Serial chain today (all in `client/app.js` unless noted):
1. `_finishLoading` (`:477`) awaits `_awaitSceneryBuild` (`:484`, `:403-422`), which races `_buildWorldScenery()` against a 45 s stall timer (`:341-342`, `:356-369`).
2. `_buildWorldSceneryOnce` (`:608`):
   - `await _hmrFactories.createTerrainBackdrop(...)` (`:613`). Serial, nothing overlaps it. Its internals were not read (Gap).
   - `_ensureRocks`, `_ensureGrass`, `_ensureVegetation` run in parallel (`:645`) and are joined at `:647`.
   - `_ensureCaves` (`:648`) and `_ensureWeather` (`:649`) run after the join. No dependency on foliage was read; candidate to overlap (Gap).
   - Prewarm `Promise.all` of veg/rocks/grass, each with `PLAYABLE_BUDGET_MS = 4000` (`:660`, `:668-672`).
   - `warmSceneryShaders` (`:675`) runs after prewarm, serially.
   - `_publishWorldExists()` (`:683`) only after all of the above.
3. `_publishWorldExists` (`:373-402`) logs the `[boot] world exists` line at `:401`. It is gated on `terrainBackdrop`, `window.__terrain`, and `_sceneryProgress.settled` (`:375-379`). So "world exists" includes the 4 s prewarm budget and the scenery shader warm.
4. `_revealWorld` (`:449-476`) runs **twice**: early at `:646` (overlapping foliage, already parallel), and again from `_finishLoading` at `:515`. Inside it:
   - `_warmWorldShaders` (`:439-448`) races `warmupShaders` against `SHADER_WARMUP_MAX_MS = 6000` (`:340`, `:446`).
   - `whenProgramsReady(renderer, 6000)` (`:462`, implementation `client/core/ProgramReadiness.js`).
   - `await _worldBuiltPromise` (`:465`), then `loadingScreen.hide()` (`:466`). The hide is serialized behind world build, not behind shaders.
5. Asset download is kicked late: `initAssets` (`app.js:948`) is called from the WORLD_DEF handler at `:1239` and from `:1311-1312`. So the player VRM and animation library cannot start until the world definition has arrived over the socket. `loadingMachine.send('WORLD_CONFIG')` is at `:1308`, `MODELS_DONE` at `:1317`.

Candidate overlaps (dependency not yet proven, so each needs a read before change):
- A. `_ensureCaves` and `_ensureWeather` (`app.js:648-649`) could overlap with the prewarm `Promise.all` (`:668`).
- B. `warmSceneryShaders` (`:675`) could start while prewarm is still running, or in parallel with the entity warm in `_warmWorldShaders` (`:446`). Both compile programs in one GL context.
- C. `initAssets` (`:1239`) could start from the URL in `sessionStorage` or the static `worldDef` before WORLD_DEF arrives. Only if the VRM URL is known statically. Unverified.
- D. The `_revealWorld` shader wait (`:446`, `:462`) is capped at 6 s twice. A cap that fires means shaders are still compiling when the scene is shown (Inference, not measured).

## Shader cache and warmup skip

- `client/core/SceneSetup.js:401` and `:423` store a marker in `localStorage` under `lastShaderWarmupKey`. Key is `shader-warmup-v4:m<manifested>:<total>:<ids>` (`:400`). When equal, the warmup is skipped (`:401`, log `[shader] skipped warmup (scene unchanged)`).
- That marker persists **no compiled program**. It records a claim that the driver/browser still has the programs. A WebGPU or WebGL program cache lives in the browser/driver, not in this app. So a skipped warmup on a reload leaves the first frames to compile lazily (Inference, consistent with the `_revealWorld` cap in candidate D). Not measured. Test with `scripts/first-frame-boot-witness.mjs`.
- No `caches.open` in `src/` (0 hits). `client/service-worker.js:1-4` defines `spoint-shell-v3`, `spoint-nav-v1`, `spoint-deps-v1`, `spoint-assets-v1`. These cache HTTP responses, not shaders.

## Asset and bake caches, with cache keys and miss reasons

1. **ProgressiveBake (GLB/VRM)**: `src/static/ProgressiveBake.js:28-40`.
   - Directory: `CACHE_DIR_NAME = '.progressive-cache'` (`:6`) next to the source file.
   - Key: `${basename}-${sha1(file bytes)[:16]}-${PROGRESSIVE_BAKE_CODE_VERSION}` (`:38-39`).
   - `PROGRESSIVE_BAKE_CODE_VERSION = bakeCodeVersion(BAKE_INPUTS_PROGRESSIVE_BAKE)` (`src/static/BakeCodeVersion.js:138`).
   - `bakeCodeVersion` hashes the **full text** of each input, CRLF-normalized (`BakeCodeVersion.js:13-19`), comments included.
   - Miss reasons: (a) source GLB bytes change; (b) any edit, including a comment, to any file in `BAKE_INPUTS_PROGRESSIVE_BAKE` (`:41`) changes the version and misses every bake; (c) superseded bakes are pruned (`ProgressiveBake.js:59`).
   - Fixable: (b) is a direct conflict with the project's comment-sweep invariant. A comment-only sweep of the bake inputs invalidates all progressive bakes. Options: hash a comment-stripped AST, or pin the version to a hand-bumped constant.
   - Repeated cost: `getProgressive` (`:144-146`) calls `_hashFile` (`:28-30`) which reads the whole GLB with `readFileSync` on **every** call. Candidate: memoize by `(path, size, mtimeMs)`.
   - Logs: `[progressive] baking <file>` (`:163`), `[progressive] done <file> in <ms>ms` (`:167`), `[progressive] pruned superseded bake` (`:59`), `[progressive] sanitized` (`:107`, `:123`).
2. **Client GLB transform cache**: `client/.glb-cache` (`scripts/cold-load-gate.mjs:36`). Its writer was not read. Gap.
3. **Heightfield bake**: `scripts/bake-heightfield.mjs` with `BAKE_INPUTS_HEIGHTFIELD_BAKE` (`BakeCodeVersion.js:82`), loaded fail-loud by `src/terrain/TerrainPhysics.js` `loadBakedHeightField` (AGENTS.md "Terrain and colliders"). Miss reasons per AGENTS.md: hashVersion, terrainKey, chartEpoch mismatch warns and falls back.
4. **Shader warmup marker**: see above.

## Server boot: `src/sdk/ServerBoot.js boot()`

Order as written (line numbers in `ServerBoot.js`):
- `:153-154` `ensurePacked` (msgpack).
- `:158-160` `locateWorld` then `loadWorldModule`. Log `[boot] using world:` at `:159`.
- `:167` `ensureServedAppsManifest`. Logs `[apps-manifest]` (`:170-171`).
- `:190` `createServer(config)`. Inside, `src/sdk/server.js`:
  - `:128` `await installAoiCodeEpoch()`.
  - `:131` `createServerDeps`, which does `await physics.init()` at `server.js:42`. This is the Jolt WASM init, serial.
  - `:96` `buildTickHandler` runs at wire time, before the world loads.
- `:192` `server.loadWorld(worldDef)`. `src/sdk/ServerAPI.js:50-121`:
  - `:78` `await appLoader.loadAll()`.
  - `:87` `await setupTerrainStreaming(...)`. Throws `[terrain] world "<id>" has no terrain` at `:90` (fatal).
  - `:98` `stageLoader.loadFromDefinition`.
  - `:114` `await appRuntime.waitForPendingTrimeshBuilds()` (5000 ms cap, `src/apps/AppRuntime.js:181`, warn at `:192`).
  - `:115` `await restoreWorldSnapshot(ctx)`.
- `ServerBoot.js:197-200` **second** `waitForPendingTrimeshBuilds()`. Already drained by `ServerAPI.js:114`, so this is normally near-zero. Candidate to remove after confirming.
- `:206-216` Prewarm. `:214` `await prewarmFiles(referenced)` is serial and blocks listen. `:215` `setImmediate(prewarm(appsDirs))` is background.
- `:217-227` Progressive. `:222` `prewarmProgressive` (not awaited). `:223-226` `await Promise.all(ensureProgressive(...))` for environment bakes **before** `start()`. Blocks listen.
- `:231` `server.start()`. `ServerAPI.js:119-121` then `:181` `httpServer.listen`, and `:270-271` `tickSystem.start()`.
- `:232` log `[server] http://localhost:<port> @ <tickRate> TPS`.

Overlap candidates on the server:
- E. `prewarmFiles` (`ServerBoot.js:214`) and the env `ensureProgressive` `Promise.all` (`:225`) are independent and both block listen. Run them in one `Promise.all`.
- F. `physics.init()` (`server.js:42`) does not depend on `locateWorld`, `loadWorldModule`, or `ensureServedAppsManifest` (`ServerBoot.js:158-167`). Start it first and join it at `createServer`.
- G. Remove the duplicate `waitForPendingTrimeshBuilds` at `ServerBoot.js:197-200` (see above).

Singleplayer worker (`src/sdk/WorkerEntry.js init()`, line 43):
- `:44` `await ensurePacked`.
- `:82` apps load in `Promise.all`.
- `:109` `await physicsReady`.
- `:113-118` `setupTerrainStreaming(...)` is **not awaited** (`.then`/`.catch` only). The heightfield can arrive after `init()` returns. This is the path the spawn-hold guards (`src/sdk/Relocation.js:167`).
- `:120` `await placedPromise`. `:132` `waitForPendingTrimeshBuilds`. `:133` `restoreWorldSnapshot`.

## Spawn hold: where it is decided and logged

- `src/sdk/Relocation.js:167-195` `holdSpawnUntilGrounded(ctx, playerId, sp, {rejoin})`. Uses `beginTeleportHold` with `maxMs: SPAWN_HOLD_MAX_MS` (20000 per AGENTS.md).
- Logs: `[terrain] holding player ... no heightfield collider covers it yet` and `[spawn-hold] holding player ...` (`:161-164`, emitted once per reason via `warnedReasons` at `:170-175`); `[spawn-hold] releasing player ... after N ms without ground` (`:185`).
- Silent: a successful release places the player (`:188-192`, `placePlayerAt` at `:197-213`) and logs **nothing**. Also `placePlayerAt` broadcasts `player_teleport` (`:212`), the only signal.
- Callers: `src/sdk/ServerHandlers.js:118` (`{rejoin: !!rejoin}`), `src/sdk/Relocation.js:305` (re-export).

## Server internals: CLI-readable vs not

CLI-readable without a browser (stdout of the node process, or loopback HTTP):
- `[boot]` lines: `ServerBoot.js:159, 163, 176, 199` and the `FATAL` at `:69-70`, `:110-115`.
- `[loadWorld]` `ServerAPI.js:66`, `:82`. `[terrain]` world-has-no-terrain throw `:90`.
- `[prewarm]` `ServerBoot.js:207`. `[progressive]` `:224-227`. `[placed-model]` `ServerAPI.js:111`, `:113`.
- `[server] http://localhost:<port> @ <tickRate> TPS` `ServerBoot.js:232`.
- `[tick-dilation] factor=N` `src/sdk/server.js:194` (only tick-related log).
- `[spawn-hold]` warnings `Relocation.js:161-164, 175, 185`.
- **HTTP, loopback only**: `GET /debug/server` routed at `src/sdk/ServerAPI.js:142` to `handleDebugServer` (`src/sdk/ServerAPIRoutes.js:95-109`). Returns JSON: `tick`, `tickRate`, `players`, `entities`, `connections` (stats), `sessions`, `heap`. Non-loopback returns 403 (`:97`). This is the best existing probe: `curl -s http://127.0.0.1:<port>/debug/server`.
- `POST /debug-log` `ServerAPI.js:140` to `handleDebugLog` (`ServerAPIRoutes.js:52`). Client-to-server log sink. Destination not read (Gap).

In-process only: `globalThis.__DEBUG__.server` (`src/sdk/server.js:197-198`). Not reachable from the CLI.

Not observable from the CLI (no log, no probe):
- Tick loop: no per-tick, first-tick, or tick-lag log. `tickSystem.start()` (`ServerAPI.js:271`) is silent. `TickSystem.onDilation` is the only tick log (`server.js:192-195`).
- Boot phase timings: `ServerBoot.js` has **zero** `Date.now`, `performance.now`, or `hrtime` calls, so no phase duration is ever printed. This is the cheapest high-value add: one `[boot-timing] <phase> <ms>` line per `await` at `:153, 158, 167, 190, 192, 198, 214, 225, 231`.
- World load phases: `ServerAPI.loadWorld` (`:50-121`) has no timing.
- Spawn hold success path: silent (see above).
- Collider streamer: not checked for logs in this pass (Gap).

Browser-only (console, reachable via CDP):
- `[boot] world exists at Nms` (`app.js:401`), `[shader] warmup done` (`SceneSetup.js:425`), `[shader] skipped warmup` (`:401`), `[progressive]` (client-side reads are server-side only).
- Reachable from the CLI through `scripts/lib/cdp-browser.mjs` `launch()` (`:474`), which enables `Runtime` (`:336`) and handles `Runtime.exceptionThrown` (`:387`). Headful only (AGENTS.md "Browsers"). Witnesses already in use: `scripts/cold-load-gate.mjs` (`isReady` timing), `scripts/first-frame-boot-witness.mjs` (TTFF and first-frame cost; prints `RESULT:` at `:382`), `scripts/page-boot-witness.mjs`.
- `window.__app.worldExistsProof`, `worldExistsAt`, `revealedAt`, `sceneryBuild` (`app.js:343-344`, `:387-398`). Readable by `page.evaluate`.
- `window.__lastShaderWarmup` (`SceneSetup.js:379-388`) records `wallMs`, `manifestDriven`, `manifestResidenceWaitMs`, `manifestUnresolvedUrls`. Good data, not logged.

## Headless / node-only reproduction of the spawn-ground failure

- `scripts/tps-game-spawn-ground-hold-witness.mjs` boots the real server **in-process** via `boot()` (header lines 16-17), uses a random port `39000 + rand(500)` (`:59`), connects a `ws` client to `/ws` (`:186`). No browser.
- Checks: (1) the world declares a spawn (`:159`); (2) the collider probes ground under the spawn (`:173`); (3) the spawn handed to `playerManager.addPlayer` is within `ACCEPT_SPAWN_M` of ground (`:243-244`); (4) the settled player rests on ground (`:256`); (5) groundless: a non-finite terrain probe arms the hold (`:96`); (6) the hold has a finite budget (`:102`); (7) the hold releases at deadline (`:112`).
- Output: one `RESULT: PASS|FAIL` line (`:267`). Covers the DEFECT 1 (declared y authors an ~8 m gap) and DEFECT 2 (bail-out on non-finite probe) described in its header (`:4-27`).
- Limit: covers spawn and hold logic, not the client, not the shader warmup, not progressive bake timing.
- Also node-only: `scripts/server-handlers-witness.mjs`, `scripts/standalone-server-witness.mjs` (plain `node:http`), `scripts/spawn-clearance-witness.mjs`, `scripts/collider-ring-boot-batches-witness.mjs`. Not read in detail; names suggest node-only.
- Related lead: `reports/Agentic troubleshooting CLI iteration speed.md:21` notes `scripts/check.mjs` `FIXED_RESOURCE` misclassifies `tps-game-spawn-ground-hold-witness.mjs` (random port) and five others, about 54 s of serial work. Fixing the classifier would let these run in parallel.

## Recorded numbers

- Cold load baseline: 54552 ms, navigation to `loadingMachine.isReady`, from `.cold-load-baseline.json` (2026-10-16 15:44), gate limit 68190 ms (`cold-load-gate.mjs:128`).
- `[boot] world exists` 77369 ms and 85692 ms: NOT verifiable in repo (see table).
- Shader warmup caps: 6000 ms (`app.js:340`), scenery prewarm budget 4000 ms (`app.js:660`), scenery stall 45 s and watchdog 30 s (`app.js:341-342`), manifest residence and trimesh wait 5000 ms (`AppRuntime.js:181`).
- Spawn hold max: 20000 ms (AGENTS.md, `SPAWN_HOLD_MAX_MS`).

## Gaps

- `createTerrainBackdrop` internals (`app.js:613`) not read. Its duration is the largest unmeasured serial step.
- `client/.glb-cache` writer not read. Production cache path assumed equal to the gate's `client/.glb-cache`.
- Collider streamer logs not checked.
- `client/service-worker.js` runtime strategy (what it serves on a cold profile) not read beyond cache names.
- `handleDebugLog` destination not read.
- Overlap candidates A-G are dependency-unverified. Each needs a read before a change.
- No cold-run timing log of the currently-recorded runs exists beyond the 54.5 s baseline.

## gm tooling friction seen while researching (INVARIANT 2/4)

- Every `gm.codesearch` reply carried `bundle_stale: true`: the server serves bundle 0.2.128 while 0.2.129 is installed at `/data/cache/gm/.gm-tools/gm-mcp-server.mjs`. Restart required. Not fixed here.
- Replies reported `stale_tree.behind: 31` (checkout behind upstream) and `listing_incomplete: true`, `nested_worktrees_unlisted: true`, so zero-hit results are not findings. The `110 seconds` and `150 seconds` zeros fall in this category.
- Replies are about 12-15 KB each, mostly dispatch metadata and a repeated `stale_tree` block. Candidate to compact (INVARIANT 5).
- Phrase queries with spaces return zero unless split: `codesearch "boot world exists"` gave 0 with a hint to use `combine`.
