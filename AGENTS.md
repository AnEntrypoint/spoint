--JULES STOPGAP DONT EDIT START--

## Skills

This project has task-specific skills available.

> **MANDATORY:** Before writing any code, creating any file, or running any command,
> you **MUST** first read `SKILLS.md` and check for relevant skills.
> This step is **non-negotiable** and applies to **every task** without exception.

**Steps to follow before any task:**
1. `view SKILLS.md` — discover all available skills
2. `view` every skill file that is plausibly relevant to the task
3. Only then proceed with the task

Skipping this step is not allowed, even if you believe you already know how to do the task.
Skills encode environment-specific constraints that override general knowledge.

--JULES STOPGAP DONT EDIT STOP--

# AGENTS.md; Non-obvious Technical Caveats

sN = section N of docs/measurement-figures.md.

## Working rules

- Commit as lanmower, main-only; `git_commit` with explicit `paths` (pathless `git_finalize` sweeps another lane's edit). Push `git_push {rev:"HEAD"}`; bare `git_push {branch:...}` is gate-denied while foreign dirt exists. `amend` refuses pushed HEAD and can't strip CR from a landed CRLF blob; repair = `git_reset_head` + re-commit.
- `.git/index.lock` fails `git_commit`. A foreign stalled git holds it 20+ min: confirm via `Get-CimInstance Win32_Process`; 0-byte lock + no spoint git alive = removable.
- Generated artifacts ship with source: `AppContext.js` -> `sdk-typings.generated.d.ts`; height-code change re-bakes `apps/world/*.hf`.
- `check-cache-keys.mjs` is shared: editing another transform's `BAKE_INPUTS_*` reddens `npm run check` for every lane until the `cacheCodeVersions.js` pin bumps in the same commit. `check.mjs` parses TRACKED files only. `BAKE_TRANSFORMS` entries (`BakeCodeVersion.js`) name the narrowest module transform reads, not its import closure. Compute a bake pin on a CLEAN tree: `check.mjs` hashes WORKING-TREE content while CI hashes COMMITTED content, so a pin computed in the main worktree while another lane holds uncommitted dirt in an input file is already wrong at commit time and reddens CI (measured 2026-10-11 on `b4b4272b`: `SNAPSHOT_ENTITY_ENC` and `COLLISION_GRID` stale at the commit). Use a throwaway worktree at `origin/main`, run the check there, and commit and push from that worktree.
- `core.autocrlf=true` lives only in SYSTEM config (gm's git missed it until the host stopped blanking global config). 211 files are index-LF + worktree-CRLF (false `modified`); `w/crlf` in `git ls-files --eol` = no diff. A CRLF blob shows as one whole-file rewrite in `git show` (`43097ece`, `e233212d`: 11+/5- -> +122/-122). Verify with `git ls-files` + `git hash-object --path`, not the verb's `removed`/`staged`.
- `.gitignore` re-includes `.gm/*` only under `.gm/memories/` + `.gm/disciplines/project/`; other `.gm/` paths are silently uncommittable.
- Untracking: gm `git_rm {"cached":true}` + paths-scoped `git_commit` (`index_commit:true`); `git ls-files` paths stay byte-identical or re-add. `git_reset {paths}` path-scoped; bare `git_reset {}` refused.
- gm MCP = HTTP (`http://127.0.0.1:8787/mcp`), not stdio. Connects once, never retries; a startup gap detaches it for the session (recover via `/mcp`). CLI `gm-dispatch.mjs <verb> '<json>'`; backslashes in a body get mangled: file it, pass `"$(cat file)"`.
- `@spoint/ecs` resolves only via `@spoint/*`; the link can vanish mid-session and kill every harness. `npm run links` restores it; never `npm install`.
- `scripts/gpulock.mjs run <owner> -- <node> <script>` serializes accelerated arms via `.gpu-lock/owner.json`; ADAPTER only, never CPU. Exits 0 on a failed witness: grep the log for `RESULT:`.
- Never `git worktree remove` a `scripts/worktree-setup.mjs` worktree (its node_modules junction deletes `node_modules/.bin`); use `scripts/worktree-teardown.mjs`.
- gm spool `in/<verb>/<session_id>-<random8>.txt`: write sibling `.tmp`, RENAME onto `.txt`; a straight write dispatches a torn body.
- CI: completing jobs = `check` + `frame-time-coverage`. `frame-time` has `if: vars.CI_GPU_RUNNER_ONLINE == 'true'`: no runner + var unset = SKIPPED. `concurrency` group is PER SHA. CI Node 20; box Node 24.
- `npm run check` (gpu-free arm -> `fire-witness-gate.mjs` -> `check-frame-time-baselines` -> opt-in `SPOINT_GPU_WITNESS`) parses only tracked `src,client,apps,scripts,bin`; refuses browser/GPU witnesses by name. A witness must exit 0 AND print `RESULT: PASS`, pinned to a `must:` regex. Gpu-free admission = capability (no browser, no GPU context), not cost.

## Repo boundaries

- `design` ships as pinned CDN URLs in `client/{index,landing/index,editor/thebird-host}.html` + `scripts/bundle-client.mjs`; `vendor/*` = editing-only submodules.
- `apps/*` never imports `client/*` (singleplayer Worker resolves relative specifiers vs a virtual root); expose utilities on `engineCtx`.
- Node-only dynamic import specifiers stay opaque to esbuild/wrangler: IIFE, `(() => './' + 'ServerAPI' + '.js')()`. `edge/cf-do/spoint-do.js` imports `jolt-edge-init.js` BEFORE `WorkerEntry.js`.

## Debugging discipline

- A bug surviving a threshold change is not fixed; re-diagnose.
- `spatial.mutations` is stable in a quiescent world (`SpatialIndex.update` skips under `distSq < 1.0`, `src/spatial/Octree.js:67`); don't assume a mutation-keyed epoch changes per tick.
- A cause stated in a report is a claim until instrumented: a PRD row blaming per-tick `spatial.mutations` was filed unchallenged and disproved by the live window. Fix a failure at its own layer end-to-end; a second copy of the same check is not a fix (`ShapeBuilder.js`, `cluster-lod-mesh.js`).
- **Silent-no-op class**: a knob with no consumer, or whose enable bit defaults off, reads as a lever and measures nothing: `?noveg`, VDRS `__vdrsScale`, `?legacygl=1`, `u.fsCheap`, `perf-run.mjs inputReachedGame`, `perf-run.mjs --no-walk` (static arm: GPU time far below wall frame; walking arms for GPU timing, s1). Codesearch a knob's reader + enable bit first; a legacy-only key writes a global nobody consumes and reports a clean null. MICRO_JITTER (static-collision-cpu-witness) stays 0: only `--mode=micro` reads it; no tracked file runs that arm.
- libuv `uv_async_send` assert fires at `process.exit()` with handles mid-close; headless scripts await `process._getActiveHandles()` hitting 0.
- `scripts/lockstep-cheat-peer.mjs` throws (exit 1) unless argv[6] is a cheat tick in 1..totalTicks.
- A witness needing the server to act on a client message passes `--params=multiplayer` (`?singleplayer` sees `players:0`, acks `ok:false`). A harness returning uncompared `{expected, got}` passes either way: one `expect()` per measurement, non-zero exit.
- One `gl.getError()` code covers distinct bugs (1282 = feedback-loop, sampler-type-mismatch AND insufficient-buffer-size): read the driver's console string off a cache-disabled reload.
- Live GL: `window`/`document` access only via `page.evaluate()` in a capture-prefixed script; pin file:line via `addInitScript` wrapping `drawElementsInstanced` (drain, then check `gl.getError()`); editor via `app.clientMachine.send('TOGGLE_EDITOR')`.
- `scripts/lib/` troubleshooting: `head-vs-worktree.mjs <paths>`, `gm-dispatch.mjs <verb> [body]`, `witness-audit.mjs`. `witness-audit.mjs --gate` = gpu-free arm of `npm run check`: per-file per-check counts vs committed `.witness-audit-baseline.json`; fails on an absent check id or a count above it.

## Entry points

- `ctx.defineGameFSM(spec)` `src/behaviours/game-fsm.js`; `ClientMachine.js` xstate5 parallel, fallback `after:` 10 s gated / 45 s hard stop.
- `ctx.defineFire(spec)` `src/behaviours/fire.js` (wired at `src/apps/AppContext.js:387`, default off).
- Test relocation: `window.__spoint` + `MSG.TELEPORT` (0xc2 / ACK 0xc3, `src/sdk/Relocation.js`; no `EDITOR_TOKEN` = any client; `relocation:false` disables; >87 deg refuses). `window.__spoint._drive` = `Relocation.js drive()`.
- Client `ctx.state` = entity `custom` block (`AppModuleSystem.js`), not server app state: `ctx.state.<key> ?? literal` takes the literal forever. `engine.cam` = camera CONTROLLER, no `position`; read `engine.client.getLocalState().position`.
- Wireweave attach helpers run after awaits (host migration reassigns `client` in `app.js`): re-check at call time.
- `createServer()` is a per-call factory; `boot()` SIGINT/SIGTERM handlers are process-global: stop with `RoomDirectory.stopAll`.
- Remote server's `netcode.profile` is named only when the client = real `PhysicsNetworkClient`: boot that witness on `?connect=...&multiplayer=1`, else in-page `BrowserServer`.

## Fire

- Integer-only kernel `fireKernel.js`: decisions from `hash(seed, step, face, I, J)`; no float, `Math.random`, `Date.now`.
- Rain smothers, does not eat fuel: a rain-suppressed cell still burns `burnRate`, pushes no heat, spots nothing (`fireKernel.js burnCell`). `rainPerIntensity` (255, `fireSpec.js`) maps intensity 0..1 to a roll byte.
- `ctx.navCostAt(x,z)` = 8 burning / 2 charred; `canSee` smoke-gated via `_fireNavByRuntime` at depth >= `smokeBlockDepth`.
- Wind = weather vector (BASE) + `hash(seed, step)` gust, clamped +-16 per axis; `snapshot().wind` carries BASE only.
- Per-cell initial fuel isn't recomputable in the kernel (`classify()`, `VegPlacement.js`): a per-tile array in `snapshot()`/`restore()` joins `TILE_ARRAYS` (`fireKeyframe.js`) + VERSION bump.
- Tampered keyframe rejected at DECODE (`[fireKeyframe]` error). `G` = ignition step mod 256, not age; IGNITE_AREA kind 5.
- Boundary snapshot's `delta` rolls back the step BEFORE it (`takeDelta` at t=K reads `preStep` captured at K-`stepTicks`); restore verifies against the boundary's `counters`, never its `delta`. `adopt`/`rewindTo`/`submit` return `{ok, reason, detail}`.

## Planet-wide multiplayer

- One server world per cluster, own flat chart. Jolt heap fixed at `JOLT_WASM_HEAP_BYTES` 134217728 B (`src/shared/clusterConfig.js:9`), never grows; over it `new J.JoltInterface` raises `Aborted(OOM)`.
- Three limits, not one cap: `maxContactConstraints` under requirement drops contacts silently; `maxBodies` under population makes Jolt return body id 0, so overflow bodies share one map key and `destroy()` aborts wasm.
- Assignment is pure, hysteretic, antipodal-safe, 2-4 Hz; `resolveClusterConfig` refuses a link below relevance ring or longest weapon range.
- Collider rings (`ColliderStreamer.js`): `DEFAULT_MAX_CENTERS = 192` for BOTH trunk + rock streamers; rings per connected player, never centroid. `classifyRings` per-cluster quota resets every pass (first-fill, no guarantee); `evictOverCap` is farthest-first.
- `clusters` occurs 0 times under `apps/` (2026-10-10): `resolveClusterConfig` (`src/shared/clusterConfig.js:35`) returns `null` for every shipped world: planet-wide multiplayer is dead, not untested. No shipped app declares `planetRadius`; `resolvedPlanetRadius` (`src/stage/Stage.js:4`) maps undeclared to 0, so cube-sphere branches (`resolvePlayerCell`, `solveCellViewer`, `computeRingRelevantIds`) never run; only the flat ring path is live or covered.
- Flat AOI query is HORIZONTAL (`src/spatial/Octree.js:113` `nearbyHorizontal`, `src/stage/Stage.js:62` `getRelevantEntitiesHorizontal`, `StageLoader.js:110`; chosen at `TickHandlerAOI.js:132` when `planetRadius <= 0`), not height-tracking: the ring has zero vertical slack; a cell centre sits exactly `relevanceRadius` from each edge-neighbour centre, so any vertical component excludes every entity.
- `checkSlices` (`worldResolve.js:33`) rejects non-positive-finite `planetRadius`; `StageLoader.js:20` throws when a radius is declared without enabled clusters. `StageLoader.js:15` runs `resolveClusterConfig` on EVERY load, so six `ClusterConfigError` codes (`src/shared/clusterConfig.js:39,44,45,47,49,51`) can throw at boot and on hot reload with no stage-specific catch: latent, no shipped world reaches it.

## Chart re-anchor

- Chart-local server holders migrate via `src/sdk/chartState/` (`attachServerChartMigrators(ctx, service)`). Re-anchor = change of basis, not rotation: position/velocity/forward invariant. CHART_REANCHOR = 0xc6.
- Flat chart tilt is fixed by shrinking the chart: `CHART_ANCHORS_PER_FACE = 32`. `CHART_REANCHOR_ANGLE_DEG` (28 / 14) must exceed the worst angle of `createChartAnchorLattice`, or the anchor thrashes.
- Exactly ONE chart per world; players at separation Delta sit at Delta/2, walkable iff `terrainTilt + Delta/2 <= 45 deg`.

## Physics and Jolt

- `physics.setBodyMotionType` returns a NEW body id or `false`. A Static-created body can't simulate via `SetMotionType`, hence recreation. `IsActive()` is the only discriminator: `GetMotionProperties()` is non-null even on a static-created body.
- Recreation creates the new body BEFORE destroying the old, on `LAYER_DYNAMIC`; refuses a body holding a constraint, vehicle chassis or trimesh/mesh/heightfield shape.
- Pooled body with `bodyMeta.type` != requested motionType is destroyed + replaced (pool key = model|scale only); a matching slot revives via `_revivePooledBody`; `removeBody` on pooled DYNAMIC does `DeactivateBody` + zeroes both velocities.
- `BodyInterface.GetPosition` returns ONE shared temp: two calls alias (`addConstraint` reads default anchors via `getBodyPosition`). Jolt recycles removed bodies' tree nodes only in `physics.step`: re-adding thousands of bodies with no step between aborts wasm.
- Jolt `HeightFieldShape` exposes `GetMinHeightValue()`/`GetMaxHeightValue()`/`GetSampleCount()`, NOT `get_mMinHeightValue`; `GetSampleCount()` = PER-SIDE count (N), not N*N.
- Trimesh/convex collider build failure in `src/apps/AppPhysics.js` PROPAGATES as `ColliderBuildError`; never degrades to a 0.5 m box. `AppRuntime` `config.autoTrimesh` branch + `EditorHandlers.js` still box.
- `ent._bodyDef` (`src/apps/AppPhysics.js:87`) keeps the convex hull for dynamic bodies.
- `AppRuntimePhysics.js` skips `e._vehicleId != null` in BOTH `_tickPhysicsLOD` + `_enforceBodyBudget`. Height samples snap to 1 mm via `+ 0`: `Math.round` of a negative sample yields -0; -0/+0 differ as `Float32Array` bits.
- `VehiclePhysics.js`: never `J.destroy` `v.constraint`/`v.tester` after `RemoveConstraint`, nor `get_mTracks()` copies after `set_mTracks`; empty `mDifferentials` = zero wheel torque.
- EDITOR_UPDATE calls `syncEntityCollider` AFTER `changeBodyType` (which removes the body and clobbers `custom._collider`).

## Terrain and colliders

- `solveSurfaceY` tolerance absolute `1e-4` (`SURFACE_SOLVE_TOLERANCE_M`, `PlanetFrame.js`), 64-eval cap, throws `SurfaceSolveError`; past 63.6 km returns `-(R+anchorHeight)`, NO throw.
- Baked heightfield FAIL-LOUD (`src/terrain/TerrainPhysics.js`): absent = silent CPU fallback; unreadable/truncated/bad-magic/stale-code throw `[baked-heightfield]`; `hashVersion`/`terrainKey`/`chartEpoch` mismatch warns + falls back.
- No terrain FATAL: `ServerAPI.loadWorld` rethrows `[terrain] world "<id>" has no terrain`; every caller stops the server it created first.
- Two height backends: v2 = parity backend; carves (`terrainCarvesOf`) v2-only. Height-difference figures: s9.
- `elevationAtLocal(frame,x,y,z)` = exactly `|p|-radius`; app-facing `ctx.terrainHeightAt` is NOT that.
- `PlanetFrame.groundHeightLocal` caches in 4096 direct-mapped slots keyed by EXACT `(x,z)` + chartEpoch (memoises `SurfaceSolveError` too).
- `terrain.glsl` `snoise3`/`vnoise2`/`seaHash`/`hpfSample` take the in-cell fraction as `P-floor(P)` from ONE `floor`.
- Server terrain collider = ONE fixed-anchor local tangent plane (`anchorDir` default [0,1,0]): can't represent directions past ~87 deg from anchor.
- `gl-render.js sampleGroundM` is fire-and-forget async (PBO+fence): each call returns the PREVIOUS call's harvested height. Non-rAF callers use `sampleGroundMSync`, which poisons the next async collision read.
- `VegPlacement.js`/`RockPlacement.js` read climate before `surfaceOfCell` only when `climateUsesLocalXZ !== true`. Veg density must gate on painted snow, else surviving grass weight roots trees.
- Snow resamples only after >0.1 m drift (`SNOW_GROUND_RESAMPLE_DRIFT_M`, `Weather.js:168`). Counted effect: s9.
- REFUTED, don't retry blind: 2-tap forward difference in `src/terrain/PlacementChart.js radialSlopeAt`; the gradient crosses `SLOPE_MAX` 0.6, flipping gate decisions.

## Netcode and wire

- Prediction suppresses only the blocked DIRECTION: `_reconcile` (`PredictionEngine.js`) derives `wedgeNormal` from commanded-vs-achieved motion, else `-velocity` when stopped while commanding; `shared/characterStep.js` projects out that component alone.
- Client peer separation is a win (`CollisionSystem.js applyPlayerCollisions` pushes overlap/2 per tick); correction counts: s10.
- `msgpack.js` `WIRE_STRUCTURES[1]` lists exactly the keys, in order, of `TickHandler.js _packPayload` (seq,tick,serverTime,players,entities,removed,delta,dots). msgpackr 2.0.4 writes -0 as `0x00`; `patch-deps.mjs` excludes -0 from both integer tests. Raw ws clients mirror `COALESCE_SENTINEL`/`splitCoalesced`: `0xFF` then `[uint32 LE length][msgpack]`.
- Wire v3 player record: 8 fields in a 22-byte bin; `[inputSequence, inputBuffer, groundNormal]` ride a per-recipient `me` block, so snapshots pack per recipient. `getSnapshot()` keys on `_version === _snapshotVersion` alone.
- `PhysicsNetworkClient.connect()` REJECTS with named `TransportConnectError` (`err.reason`: `websocket-unavailable`/`-error`/`-closed-before-open`, `connect-superseded`), never `connected:false` with no socket. Retry belongs in the caller (`_doReconnect`), never in fake success.
- `PlayerManager.addInput` (`src/netcode/PlayerManager.js:82`) drops input for an unjoined player or one with no input buffer.
- `SnapshotGroupPlanner`: groups = `ceil(viewers*perViewerMs/(budgetMs-fixedMs))`; budget = tick period * `SNAP_COST_HIGH_FRAC` 0.35 (`src/sdk/TickHandler.js:31`). `relevanceRadius` is set by worlds (`src/presets/tps.js:5` 200, `apps/world/construct.js:20` 100): interest management is live there; `getRelevanceRadius` (`src/sdk/server.js:92`) falls back to 0 only where a world omits it.
- Lockstep: rollback is input-capped, so measure by depth, not rate (`maxRollbackTicks` 12); `inputDelayTicks` above `INPUT_RETAIN_TICKS` (240) throws at construction.
- A socket becomes a player by MIGRATE, RECONNECT, or silence past MIGRATE-peek grace (`ServerHandlers.js onClientConnect`, 50 / 1500 ms dilated). A silent probe joins as a phantom, so probes use `?probe=1`. Never answer an unresolvable RECONNECT with INVALID_SESSION and leave it open: `rejectSession` flushes + closes.
- Migration keeps the old transport as fallback owner and hands the player back on candidate death; a close from a transport client no longer owning cannot tear it down.
- Authoritative path: prediction off by default (`?predict` only); rollback/lockstep unwired. `TickHandler.js processPlayerMovement` takes ONE input per tick, catching up only while `inputs.length > INPUT_BUFFER_CATCHUP_DEPTH` 8.
- `BaseClient.js sendInput` stops feeding `predEngine.addInput` once `predictionLeadSteps()` reaches `MAX_PREDICTION_LEAD_STEPS` 16; a fast client degrades to bounded lead.

## Rendering

- `WebGPURenderer` is DEFAULT (`?legacygl=1` opts out); unavailable WebGPU retries `forceWebGL=true` before legacy, so TSL is the only shader path. WebGPU uses TerrainBackdrop's `fE` as per-vertex clip transform; WebGL only for CPU frustum culling.
- `three.webgpu.js` drops pending `popErrorScope()` rejections at 3 sites; `patch-deps.mjs` patches all three. `ClusterLodMesh._render` fires once PER GROUP per frame: keep the `_lastRenderFrame===frame` early-return. `webgpu-hiz-shaders.js` HiZ cull must equal the CPU cull (divergence silently culls wrong cells).
- Veg LOD: `WebGPULodInstancer` oracle mirrors `updateLOD`; `lodEye` refreshes only after 0.5 m (`LOD_REEVAL_MOVE_SQ`). A leaf instancer is a SATELLITE of its branch (`opts.host`): `updateLOD` returns at once; tier/shadow/visibility mirrored.
- Every discard in the `terrain.glsl` FS stays inside `#ifdef _WATERPASS_` (a discard disables early-Z depth write for all its draws). It is the SoT for CPU/GPU height parity (`gen-height.mjs` transpiles it); deleting it needs a new SoT + TSL/WGSL->JS generator.
- Default terrain FS is TSL, not `terrain.glsl`: `TerrainBackdrop.js:43` imports `mapspinner/src/tsl/planet-tsl.js` when `isWebGPU`. `terrain.glsl` = legacy `?legacygl=1` path + height-parity SoT; its `_WATERPASS_` rule governs the GLSL body only.
- Per-pixel ALU/fetch counts on the live TSL path are static counts, not timings; never read them as measured cost (s7).
- `terrain-lighting-tsl.js` gates `sky.marchRadiance` on `apGate > 0` (`e233212d`): `If(apGate.greaterThan(0.0), ...)` + `apTrans`/`apRad` drop march ALU and LUT fetches per terrain pixel (`sky-tsl.js:89`; s7); `mix(lit, hazed, 0) === lit`, bit-identical. Terrain `renderOrder` 10 (`TERRAIN_DRAWS_AFTER_OPAQUE_OCCLUDERS`, `planet-tsl.js`) draws after opaque occluders (0 of 17 mapspinner tsl files use `discard`): near-neutral; don't "fix" by drawing terrain first. Water `WATER_DRAWS_BEFORE_OTHER_TRANSPARENTS` -1: shading always paid. `texFarFade > 0.001` (`surface-splat-tsl.js:133`) buys fetches for a 0.001 contribution (s7).
- TSL `select` outside `uniformFlow` emits a real `if/else` (three's `ConditionalNode`), not a ternary: both sides NOT evaluated.
- VDRS has NO consumer on the live path: `packages/mapspinner/src/tsl` has zero `vdrs`; the VDRS branch in `TerrainBackdrop.js` is unreachable. `__vdrsScale` is read ONLY when `window.__vdrs === true` (default false): scale without the enable bit does nothing.
- `?legacygl=1` silently drops unless an in-page server exists (`app.js:191`): needs `?singleplayer&legacygl=1`; flips terrain hashVersion, so a legacy run is NOT comparable to a TSL number. `u.fsCheap` swaps `outputNode` only: not a valid FS probe. Terrain `side = DoubleSide` (`terrain-material-tsl.js:198`): no backface culling.
- Dead per-pixel taps: `octFarFade` saturates at `reliefScale` 0.1; its remaining taps are already gated (`surface-splat-tsl.js:116` gates `gFar`). `bandWarp` is NOT dead: `texFarFade` holds on nearly all terrain pixels, so hoisting it saves nothing (~0; s7).
- Legacy-vs-TSL: `terrain.glsl` mixes the raw interpolated vertex normal; TSL normalizes first (s7).
- `invertAcesFilmic` must NOT end in `max(x, 0)`: saturated blue inverts out of AP1/ACES gamut and clamping mis-encodes it (s7). Rendered sea = sphere R == `PlanetFrame.waterlineLocalY` to 1 cm; waves ZERO-MEAN.
- `ShadowPipeline.js forceUpdate` sets EVERY cascade `light.shadow.needsUpdate`; `cascadeCount` clamps to 1 when `sun.castShadow===false` (cascade 0 IS the sun, never renders). `QualityPresets.js` ships `ssao`/`bloom` false.
- Vegetation `InstancedMesh2`: `sortObjects` stays false with LODs; `CullFreeze.js setInstancedCullAuto` sets `autoUpdate` on parent AND every LOD level. `model-pool.js` drains must allow >=1 unit/frame or a zero budget deadlocks.
- Veg + Rocks + `Grass.prewarm` all budget WORK (`3384c0613f`): prewarm sums `loadChunk` durations, yields on a macrotask every 24 ms, reports `prewarmMs`/`prewarmWorkMs`/`prewarmChunks`. rAF was the wrong yield (display-owned, throttled in hidden tabs). Boot-time effect: s11.

## Client and app runtime

- HUD `applyDiff(uiRoot, hudVdom)` replaces uiRoot children every frame; imperative DOM overlays mount on `document.body`.
- `_buildWorldScenery` is a joinable wrapper; boot adopts a running build (`Promise.race` does not cancel the loser).
- `app.js animate()` returns early while `window.__warmupInFlight`; model-pool + streaming loads pump from frame jobs there: never park a wait inside warmup.
- Client `WORLD_DEF` from `sendWorldDefAndModules` has `entities` STRIPPED and carries `_modelUrls`: derive world-entity facts from `_modelUrls`.
- Hot reload releases ctx via `AppRuntime._releaseAppContext`; `update()` keeps running with a torn-down ctx unless `_updateList`/`_rebuildCollisionList` are rebuilt.
- `AppRuntime._attachApp` does `apps.set` BEFORE awaiting `setup()`; `spawnEntity` attaches apps fire-and-forget: collect tagged entities on the first `update()` tick.
- `src/apps/CustomVersion.js:42`: `Reflect.set` is a deliberate raw write; a read must not reach the set trap and bump `_customV`.
- Spawn: `holdSpawnUntilGrounded` (`src/sdk/Relocation.js`) gates release on `terrainFieldMissingAt`/`coversPosition` (max `SPAWN_HOLD_MAX_MS=20000`).
- Respawn clearance shared: `src/apps/AppGameplay.js pickSpawnPoint` + tps-game use one `footprintBlockers` sampler (17 down-ray columns; surface > `MAX_FOOTPRINT_INTRUSION_M` 0.15 m above a column bottom = `intruding`).
- `BrowserServer.js`: `_lastTodSync` + `_deliveredWorldFingerprints` are MODULE level: stall recovery + HostMigration rebuild a fresh BrowserServer in the same page.
- Singleplayer worker world identity from `INIT.worldName`; snapshot = one IDB key `world-snapshot` per origin.
- `FloatingOrigin.js update()` does `camera.position.set(0,0,0)` on rebase, not `+= -delta`.

## Measurement and witnessing

- Measured figures, refutations, instrument/adapter/statistic notes: `docs/measurement-figures.md` (struck values replaced there).
- Per-pass GPU timings (`p50Ms`, `p95Ms`, `avgMs`) are INVALID as GPU-bound measures (lane a368d997: bimodal near-zero mode on 30 and 60 fps arms, s0). Quote no per-pass figure; select no arm by one. A 0 duration is UNWRITTEN (65.5 us granularity), not free. Never split stages with a `?gpuhide=` differential; sub-2 ms stages need in-run A/B on a fixed instrument.
- No `perf-run.mjs` instrument unlocks vsync (`--disable-frame-rate-limit --disable-gpu-vsync` live only in `frame-time-gate.mjs:36` behind `UNLOCK_RAF`); software rasterizers can't reach the frame-time floor. Baselines are per-vendor; an unbaselined vendor fails loudly.
- Pin each GPU arm's adapter: `vendorGpuArgs(vendor)` adds `--use-adapter-luid=0,<luid>` (`gpu-probe.mjs gpuLaunchArgs()` does not). Pinning is necessary, not sufficient: Chrome ignores an unresolvable LUID while reporting accelerated, so assert `window.__rendererInfo`'s renderer string. Never mint a WebGL2 context in a measured page.
- AMD iGPU: `--gpu-passes --extra=gputime=1 --backend=webgpu` works after `npm run build:client` (FATAL otherwise); its per-pass output is INVALID as a GPU-bound measure.
- AMD frame-time verdicts need a quiet window: `gpulock` serializes the adapter, never the CPU; a settle probe under 40 frames per 2000 ms means "box busy"; `scripts/lib/host-contention.mjs` can't see GPU-side contention. The contention gate needs a GPU-bound control page and writes no slower baseline unless `--accept-slower=<reason>`.
- Decide perf rows on counted work units. A never-incremented counter is a silent pass: confirm the field exists on the measured backend (`vegProfile.meshInstances` is absent on `WebGPULodInstancer`). Authoritative draw count = `perf-run.mjs drawsInstrument.authoritativeField`; WebGPU `info.render.calls` is cumulative, the only reliable liveness signal.
- Toggles: `?lightplanet` stubs the planet, keeps height sampler + foliage; `?veg=none`, `?nograss`, `?norocks` are real; **`?noveg` is NOT a flag** (no-ops silently). `window.__vegAllOff` kills foliage per frame; no per-part app toggle. Foliage cost: in-run A/B, never planet on/off pairs.
- `perf-run.mjs`: `?gpuhide=`/`?gpuab=<name>` (boolean); `--knob=<key>=<value>[,...]` (`?knob=` in `--extra`; number or boolean). Keys are registry `key`s verbatim (`maxLevel`, not `__maxLevel`), set at document start by a setter trap on `window.__renderControls` (so `registry.set` fires as `installRenderControls()` assigns it). A pre-boot reject names the key; one bad key fails the run. Limits: `maxLevel` 2..22, `splitFactor` >= 0.05.
- `dprAuto` default `false` (`client/core/RenderControls.js:11`, `08c227a2`), matching every preset; `client/core/FrameMetrics.js:134` reads it via the registry, so a bypassing run starts adaptive pixel ratio if the default flips. Measuring arms pass `--knob=dprOff=true` (readback can time out on heavy pages). `window.__dprAuto` is written by `client/hud/SettingsMenu.js`, read by nothing.
- `halfResWater` reads as `=== true` (`gl-render.js:1444,1555`), so unset means OFF and agrees with the `RenderControls` default `false`; a consumer with no preset (mapspinner demo, SDK) keeps full-frame MSAA instead of being forced into the VDRS FBO. The water-occlusion branch it gates also needs `window.__planetDepthToCanvas === true`, set only by `client/core/TerrainBackdrop.js:76`.
- Template literals: an untagged one turns a lone `\d` into `d`; write `\\d+`. `?gpuabms=` was inert through `3384c0613f` for this; check the escape before trusting it. `?gpuab=<name>` was never affected.
- WebGPU parity: a region matches iff cross-renderer meanAbs/channel <= 3 x max(same-renderer noise floor, `QUANT_FLOOR`); establish the same-code floor first (s8).
- `prediction-drift-witness.mjs`: `--server-tick=<hz>` is its only lever; at 10 Hz the floor is one 100 ms step, so caps must be raised.
- CDP `Input.dispatchKeyEvent` reaches the app input bucket (`window.__app.sentInput`/`sentInputCount`); keyboard sets `input.backward`, never `input.back`. `[physics] peak active 0` doesn't mean a stalled player (`CharacterVirtual` isn't counted by `GetNumActiveBodies()`).
- A witness with a fixed scratch dir must `rm` it at start (a gate run killed at its 120 s cap leaves it; later runs hang: `terrain-reseed-failure-witness.mjs`). `gm exec_js` dispatches are ephemeral; use `127.0.0.1`, not `localhost`. Headless Node witnesses constructing `PhysicsNetworkClient` polyfill `globalThis.WebSocket` from `ws`. `edge-collider-draco-witness.mjs` rewrites tracked `apps/tps-game/*.glb` in place: never run it inside a gate.

## Security

- Re-run the dependency scan on any fresh or updated `node_modules`.
- `SESCompartmentEvaluator.js` is the only untrusted-app evaluator and fails closed; `StaticHandler` enforces path containment + COEP `require-corp`. A failed `import('ses')`/lockdown throws `SandboxUnavailableError`.
- `authCompare.js timingSafeTokenEqual` self-compares (`bufA,bufA`) on a length mismatch so token length is not leaked: don't simplify it away.
- Benign exec surfaces, never flag as malware: `lang/spoint.js`, `mapspinner/planet.html`, `scaffold.js`, `cdp-browser.mjs`.
- Witness CLIs taking `--module=<path>` (the EcsQuery witness under scripts/) load that path as code: point them only at trusted files.

@.gm/next-step.md
