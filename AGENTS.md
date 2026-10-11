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

`sN` = section N of `docs/measurement-figures.md` (s0..s13). Cite `path` + symbol: line numbers drift, even in `scripts/lib/verify-doc-claims.mjs` pins.

## Working rules

- Commit lanmower, main-only: `git_commit {message, paths}` (pathless `git_finalize` sweeps another lane's edit); push `git_push {rev:"HEAD"}`, bare `{branch:...}` gate-denied while foreign dirt exists. `amend` refuses pushed HEAD and can't strip CR from a landed CRLF blob (`git_reset_head` + re-commit). A landed commit can still report `nothing_to_commit_for_paths`: witness via `git_show {rev}`.
- `.git/index.lock` fails `git_commit`; a foreign stalled git holds it 20+ min (confirm via `Get-CimInstance Win32_Process`). 0-byte lock + no spoint git alive = removable.
- Generated artifacts ship with source: `AppContext.js` -> `sdk-typings.generated.d.ts`; a height-code change re-bakes `apps/world/*.hf`.
- `check-cache-keys.mjs` is shared (pins `src/shared/cacheCodeVersions.js`, transforms `src/static/BakeCodeVersion.js`): editing another transform's `BAKE_INPUTS_*` reddens `npm run check` for every lane until the pin bumps in the same commit. `check.mjs` parses TRACKED files only; `BAKE_TRANSFORMS` entries are transform entry modules; `BAKE_INPUTS_*` must declare their WHOLE import closure. Compute pins in a throwaway worktree at `origin/main` (`check.mjs` hashes the work tree, CI the commit; `b4b4272b`: `SNAPSHOT_ENTITY_ENC` + `COLLISION_GRID` stale at commit).
- CRLF: `core.autocrlf=true` lives only in SYSTEM config. 203 files are index-LF + worktree-CRLF (false `modified`); `w/crlf` in `git ls-files --eol` = no diff, and a CRLF blob shows as one whole-file rewrite in `git show`. Verify with `git ls-files` + `git hash-object --path`, not the verb's `removed`/`staged`.
- `.gitignore` re-includes `.gm/*` for `.gm/memories/`, `.gm/disciplines/project/`, `.gm/witness-log.md`, `.gm/witness-out/`, `.gm/pool/pool.log`; other `.gm/` paths are silently uncommittable.
- Untracking: `git_rm {cached:true}` + paths-scoped `git_commit {index_commit:true}`; `git ls-files` paths stay byte-identical or re-add. `git_reset {paths}` is path-scoped; bare `git_reset {}` refused.
- gm MCP is HTTP (`http://127.0.0.1:8787/mcp`), not stdio; it connects once and never retries, so a startup gap detaches it for the session (`/mcp` recovers). CLI `gm-dispatch.mjs <verb> '<json>'`; backslashes get mangled: file the body `"$(cat file)"`. Spool body = `in/<verb>/<session_id>-<pid>-<epochms>-<rand>.txt` + sibling `.inflight` claim; write the `.tmp` sibling then RENAME onto `.txt` (a straight write dispatches a torn body).
- `@spoint/ecs` resolves only via `@spoint/*`; that link can vanish mid-session and kill every harness (`npm run links` restores it; never `npm install`).
- `scripts/gpulock.mjs run <owner> [--wait-ms N] [--ttl-ms N] -- <cmd>` serializes accelerated arms via `.gpu-lock/owner.json` (2 s heartbeat, 120 s TTL, takeover on a dead/stale holder) and propagates the child's exit code; still grep the log for `RESULT:`: five check scripts exit 0 printing none.
- Never `git worktree remove` a `scripts/worktree-setup.mjs` worktree (its node_modules junction deletes `node_modules/.bin`); use `scripts/worktree-teardown.mjs`.
- CI: completing jobs = `check` + `frame-time-coverage`; `frame-time` has `if: vars.CI_GPU_RUNNER_ONLINE == 'true'` — no runner + var unset = SKIPPED. `concurrency` group is PER SHA. CI Node 20; box Node 24.
- `npm run check` (gpu-free arm -> `fire-witness-gate.mjs` -> `check-frame-time-baselines` -> opt-in `SPOINT_GPU_WITNESS`) parses only tracked `src,client,apps,scripts,bin` and refuses browser/GPU witnesses by name. A witness must exit 0 AND print `RESULT: PASS`, pinned to a `must:` regex. Gpu-free admission is capability, not cost.

## Repo boundaries

- `design` ships as pinned CDN URLs in `client/{index,landing/index,editor/thebird-host}.html` + `scripts/bundle-client.mjs`; `vendor/*` = editing-only submodules.
- `apps/*` never imports `client/*` (singleplayer Worker resolves relative specifiers vs a virtual root); expose utilities on `engineCtx`.
- Node-only dynamic import specifiers stay opaque to esbuild/wrangler: IIFE, e.g. `src/sdk/EditorHandlers.js` `(() => './' + 'MinimapBake' + '.js')()`. `edge/cf-do/spoint-do.js` imports `jolt-edge-init.js` BEFORE `WorkerEntry.js`.

## Debugging discipline

- A bug surviving a threshold change isn't fixed.
- `spatial.mutations` is stable in a quiescent world (`SpatialIndex.update` skips under `distSq < 1.0`): don't assume a mutation-keyed epoch changes per tick.
- A cause in a report is a claim until instrumented: a PRD row blaming per-tick `spatial.mutations` was disproved by the live window. Fix a failure at its own layer end-to-end; a second copy of the same check isn't a fix (`ShapeBuilder.js`).
- **Silent-no-op class**: a knob with no consumer, or whose enable bit defaults off, measures nothing — codesearch the reader + enable bit first. Cases: `?noveg` (no such flag), VDRS `__vdrsScale` (needs `window.__vdrs===true`), `?legacygl=1` (needs an in-page server), `u.fsCheap`, `perf-run.mjs inputReachedGame`, `perf-run.mjs --no-walk` (static arm: GPU time far below wall frame), MICRO_JITTER (only `--mode=micro` reads it).
- libuv `uv_async_send` asserts at `process.exit()` with handles mid-close; headless scripts await `process._getActiveHandles()` hitting 0.
- `scripts/lockstep-cheat-peer.mjs` throws (exit 1) unless argv[6] is a cheat tick in 1..totalTicks.
- A witness needing the server to act on a client message passes `--params=multiplayer` (`?singleplayer` sees `players:0`, acks `ok:false`). A harness returning uncompared `{expected, got}` passes either way: one `expect()` per measurement.
- One `gl.getError()` code covers distinct bugs (1282 = feedback-loop, sampler-type-mismatch AND insufficient-buffer-size): read the driver's console string off a cache-disabled reload.
- Live GL: `window`/`document` only via `page.evaluate()` in a capture-prefixed script; pin file:line via `addInitScript` wrapping `drawElementsInstanced` (drain, then `gl.getError()`); editor via `app.clientMachine.send('TOGGLE_EDITOR')`.
- `scripts/lib/`: `head-vs-worktree.mjs`, `gm-dispatch.mjs`, `witness-audit.mjs`. `witness-audit.mjs --gate` = gpu-free arm of `npm run check`, HIGH tier only: per-file per-check counts vs committed `.witness-audit-baseline.json`; fails on an absent check id or a higher count. The LOW tier (`empty-catch`, `swallowed-error`) is advisory -- printed under `--all`, never written to the baseline, so a low count rising never fails it. `--gate`/`--write-baseline` audit committed tracked scripts; without either the run walks the worktree, so `--all` alone sees a different file set.

## Entry points

- `ctx.defineGameFSM(spec)` `src/behaviours/game-fsm.js`; `ClientMachine.js` xstate5 parallel, fallback `after:` 10 s gated / 45 s hard stop.
- `ctx.defineFire(spec)` `src/behaviours/fire.js` (wired in `src/apps/AppContext.js`, default off).
- Test relocation: `window.__spoint` + `MSG.TELEPORT` (0xc2 / ACK 0xc3, `src/sdk/Relocation.js`; no `EDITOR_TOKEN` = any client; `relocation:false` disables; >87 deg refuses).
- Client `ctx.state` = entity `custom` block (`AppModuleSystem.js`), not server app state: `ctx.state.<key> ?? literal` takes the literal forever. `engine.cam` = camera CONTROLLER, no `position`; read `engine.client.getLocalState().position`.
- Wireweave attach helpers run after awaits (host migration reassigns `client` in `app.js`): re-check at call time.
- `createServer()` is a per-call factory; `boot()`'s SIGINT/SIGTERM handlers are process-global: stop with `RoomDirectory.stopAll`.
- A remote server's `netcode.profile` is named only when the client is a real `PhysicsNetworkClient`: boot that witness on `?connect=...&multiplayer=1`, else in-page `BrowserServer`.

## Fire

- Integer-only kernel `fireKernel.js`: decisions from `hash(seed, step, face, I, J)`; no float, `Math.random` or `Date.now`.
- Rain smothers, doesn't eat fuel: a rain-suppressed cell still burns `burnRate`, pushes no heat, spots nothing (`burnCell`).
- `ctx.navCostAt(x,z)` = 8 burning / 2 charred; `canSee` is smoke-gated by `_fireNavByRuntime` at depth >= `smokeBlockDepth`.
- Wind = weather vector (BASE) + `hash(seed, step)` gust, clamped +-16/axis (`FIRE_MAX_WIND_COMPONENT`); `snapshot().wind` carries BASE only; `fireWire.js` rejects non-integer/out-of-range wind.
- Per-cell initial fuel isn't recomputable in the kernel (`classify()`, `VegPlacement.js`): a per-tile array in `snapshot()`/`restore()` joins `TILE_ARRAYS` (`fireKeyframe.js`) + VERSION bump.
- A tampered keyframe is rejected at DECODE (`[fireKeyframe]` error). `G` = ignition step mod 256, not age; IGNITE_AREA kind 5.
- A boundary snapshot's `delta` rolls back the step BEFORE it (`takeDelta` at t=K reads `preStep` captured at K-`stepTicks`); restore verifies against the boundary's `counters`, never its `delta`. `adopt`/`rewindTo`/`submit` return `{ok, reason, detail}`.
- `rainPerIntensity` is no longer pinned by `fireSpec.js` (its witness FAILs on the shipped tree); 255 survives only as a witness fixture.

## Planet-wide multiplayer

- One server world per cluster, own flat chart. Jolt heap fixed at `JOLT_WASM_HEAP_BYTES` 134217728 B (`src/shared/clusterConfig.js`), never grows; over it `new J.JoltInterface` raises `Aborted(OOM)`.
- Three limits, not one cap: `maxContactConstraints` under requirement drops contacts silently; `maxBodies` under population makes Jolt return body id 0, so overflow bodies share one map key and `destroy()` aborts wasm.
- Assignment is pure, hysteretic, antipodal-safe, 2-4 Hz; `resolveClusterConfig` refuses a link below the relevance ring or longest weapon range, and `src/sharding/ClusterRuntime.js` calls it with `relevanceRadius: worldDef.relevanceRadius || 200`.
- Collider rings (`ColliderStreamer.js`): `DEFAULT_MAX_CENTERS = 192` for BOTH trunk + rock streamers; rings per connected player, never centroid. `classifyRings`' per-cluster quota resets every pass; `evictOverCap` is farthest-first.
- `clusters` occurs 0 times under `apps/`: `resolveClusterConfig` returns `null` for every shipped world, so planet-wide multiplayer is dead, not untested. No shipped app declares `planetRadius`; `resolvedPlanetRadius` (`src/stage/Stage.js`) maps undeclared to 0, so the cube-sphere branches (`resolvePlayerCell`, `solveCellViewer`, `computeRingRelevantIds`) never run.
- Flat AOI query is HORIZONTAL (`src/spatial/Octree.js` `nearbyHorizontal`, `src/stage/Stage.js` `getRelevantEntitiesHorizontal`, chosen in `TickHandlerAOI.js` when `planetRadius <= 0`): the ring has zero vertical slack, so any vertical component excludes every entity.
- `checkSlices` (`worldResolve.js`) rejects non-positive-finite `planetRadius`; `StageLoader.js` throws when a radius is declared without enabled clusters, and runs `resolveClusterConfig` on EVERY load, so six `ClusterConfigError` codes (`src/shared/clusterConfig.js`) can throw at boot and on hot reload with no stage-specific catch (latent: no shipped world reaches it).

## Chart re-anchor

- Chart-local server holders migrate via `src/sdk/chartState/` (`attachServerChartMigrators(ctx, service)`). Re-anchor = change of basis, not rotation: position/velocity/forward invariant. CHART_REANCHOR = 0xc6.
- Flat chart tilt is fixed by shrinking the chart: `CHART_ANCHORS_PER_FACE = 32` (`src/shared/chartAnchor.js`). `CHART_REANCHOR_ANGLE_DEG` (28 / 14) must exceed `createChartAnchorLattice`'s worst angle or the anchor thrashes; hysteresis `CHART_REANCHOR_HYSTERESIS_DEG = 0.75` (`src/shared/chartReanchorPolicy.js`).
- Exactly ONE chart per world; players at separation Delta sit at Delta/2, walkable iff `terrainTilt + Delta/2 <= 45 deg`.
- `chartEpoch` keys re-anchor: `ChartReanchorService.js`, `ChartReanchorTerrain.js`, `FieldLattice.js`, `ColliderStreamer.js` and the `groundHeightLocal` memo gate on it.

## Physics and Jolt

- `physics.setBodyMotionType` returns a NEW body id or `false`. A Static-created body can't simulate via `SetMotionType`, hence recreation. `IsActive()` is the only discriminator: `GetMotionProperties()` is non-null even on a static-created body.
- Recreation creates the new body BEFORE destroying the old, on `LAYER_DYNAMIC`; refuses a body holding a constraint, vehicle chassis or trimesh/mesh/heightfield shape.
- A pooled body whose `bodyMeta.type` != requested motionType is destroyed + replaced (pool key = model|scale only); a matching slot revives via `_revivePooledBody`; `removeBody` on pooled DYNAMIC does `DeactivateBody` + zeroes both velocities.
- `BodyInterface.GetPosition` returns ONE shared temp, so two calls alias (`addConstraint` reads default anchors via `getBodyPosition`). Jolt recycles removed bodies' tree nodes only in `physics.step`: re-adding thousands of bodies with no step between aborts wasm.
- Jolt `HeightFieldShape` exposes `GetMinHeightValue()`/`GetMaxHeightValue()`/`GetSampleCount()`, NOT `get_mMinHeightValue`; `GetSampleCount()` = PER-SIDE count (N), not N*N.
- Trimesh/convex collider build failure in `src/apps/AppPhysics.js` PROPAGATES as `ColliderBuildError` (also raised in `AppRuntime.js`); never degrades to a 0.5 m box. `AppRuntime`'s `config.autoTrimesh` branch + `EditorHandlers.js` still box.
- `ent._bodyDef` (`src/apps/AppPhysics.js`) keeps the convex hull for dynamic bodies; `changeBodyType` clears it for static.
- `AppRuntimePhysics.js` skips `e._vehicleId != null` in BOTH `_tickPhysicsLOD` and `_enforceBodyBudget`; `_tickPhysicsLOD` runs only every `_physicsLODInterval` ticks (`AppRuntimeTick.js`). Height samples snap to 1 mm via `+ 0`: `Math.round` of a negative sample yields -0; -0/+0 differ as `Float32Array` bits.
- `VehiclePhysics.js`: never `J.destroy` `v.constraint`/`v.tester` after `RemoveConstraint`, nor `get_mTracks()` copies after `set_mTracks`; empty `mDifferentials` = zero wheel torque.
- EDITOR_UPDATE calls `syncEntityCollider` AFTER `changeBodyType` (which removes the body and clobbers `custom._collider`).

## Terrain and colliders

- `solveSurfaceY` tolerance absolute `1e-4` (`SURFACE_SOLVE_TOLERANCE_M`, `PlanetFrame.js`), 64-eval cap, throws `SurfaceSolveError`; past 63.6 km it returns `-(R+anchorHeight)` with no throw.
- Baked heightfield FAIL-LOUD (`src/terrain/TerrainPhysics.js`): absent = silent CPU fallback; unreadable/truncated/bad-magic/stale-code throw `[baked-heightfield]`; `hashVersion`/`terrainKey`/`chartEpoch` mismatch warns + falls back. Bake key = `[radius, hpfTexRes, seed, reliefScale, hashVersion, carves]`; carves (`terrainCarvesOf`) are v2-only. Figures: s9.
- No terrain is FATAL: `ServerAPI.loadWorld` rethrows `[terrain] world "<id>" has no terrain`; every caller stops its server first.
- Two height backends; v2 = parity backend. `elevationAtLocal(frame,x,y,z)` = exactly `|p|-radius`; app-facing `ctx.terrainHeightAt` is NOT that.
- `PlanetFrame.groundHeightLocal` caches in 4096 direct-mapped slots keyed by EXACT `(x,z)` + chartEpoch (memoises `SurfaceSolveError` too).
- `terrain.glsl`'s `snoise3`/`vnoise2`/`seaHash`/`hpfSample` take the in-cell fraction as `P-floor(P)` from ONE `floor`.
- Server terrain collider = ONE fixed-anchor local tangent plane (`anchorDir` default [0,1,0]): can't represent directions past ~87 deg from anchor.
- `gl-render.js sampleGroundM` is fire-and-forget async (PBO+fence), so each call returns the PREVIOUS call's height. Non-rAF callers use `sampleGroundMSync`, which poisons the next async read.
- `VegPlacement.js`/`RockPlacement.js` read climate before `surfaceOfCell` only when `climateUsesLocalXZ !== true`. Veg density must gate on painted snow, else surviving grass weight roots trees. Slope caps differ per placer: `VegPlacement SLOPE_MAX` 0.6, `GrassPlacement SLOPE_MAX` 0.9.
- Snow resamples only after >0.1 m drift (`SNOW_GROUND_RESAMPLE_DRIFT_M`, `Weather.js`); counted effect: s9.
- REFUTED, don't retry: `PlacementChart.js radialSlopeAt`'s 2-tap forward difference — the gradient crosses `SLOPE_MAX`, flipping gate decisions.

## Netcode and wire

- Prediction suppresses only the blocked DIRECTION: `_reconcile` (`PredictionEngine.js`) derives `wedgeNormal` from commanded-vs-achieved motion, else `-velocity` when stopped while commanding; `shared/characterStep.js` projects out that component alone.
- Client peer separation is a win (`CollisionSystem.js applyPlayerCollisions` pushes overlap/2 per tick); counts: s10.
- `msgpack.js` `WIRE_STRUCTURES[1]` lists exactly the keys, in order, of `TickHandler.js _packPayload` (seq,tick,serverTime,players,entities,removed,delta,dots). msgpackr 2.0.4 writes -0 as `0x00`; `patch-deps.mjs` excludes -0 from both integer tests. Raw ws clients mirror `COALESCE_SENTINEL` 0xff: `0xFF` then `[uint32 LE length][msgpack]`.
- Wire v3 player record: 8 fields in a 22-byte bin; `[inputSequence, inputBuffer, groundNormal]` ride a per-recipient `me` block, so snapshots pack per recipient. `getSnapshot()` keys on `_version === _snapshotVersion` alone.
- `PhysicsNetworkClient.connect()` REJECTS with a named `TransportConnectError` (`err.reason`: `websocket-unavailable`/`-error`/`-closed-before-open`, `connect-superseded`), never `connected:false` with no socket. Retry belongs in the caller (`_doReconnect`).
- `SnapshotGroupPlanner`: groups = `ceil(viewers*perViewerMs/(budgetMs-fixedMs))`; budget = tick period * `SNAP_COST_HIGH_FRAC` 0.35 (`src/sdk/TickHandler.js`). `relevanceRadius` is set by worlds (`src/presets/tps.js` 200, `apps/world/construct.js` 100); `getRelevanceRadius` (`src/sdk/server.js`) falls back to 0 only where a world omits it.
- Lockstep: rollback is input-capped, so measure by depth, not rate (`maxRollbackTicks` 12); `maxRollbackTicks + inputDelayTicks >= windowSize` throws; `inputDelayTicks` above `INPUT_RETAIN_TICKS` (240) throws at construction.
- A socket becomes a player by MIGRATE, RECONNECT, or silence past the MIGRATE-peek grace (`ServerHandlers.js onClientConnect`, 50 / 1500 ms dilated). A silent probe joins as a phantom, so probes use `?probe=1`. Never answer an unresolvable RECONNECT with INVALID_SESSION and leave it open: `rejectSession` flushes + closes.
- Migration keeps the old transport as fallback owner and hands the player back on candidate death; a close from a client no longer owning can't tear it down.
- Authoritative path: prediction off by default (`?predict` only); rollback/lockstep unwired. `processPlayerMovement` takes ONE input per tick, catching up only while `inputs.length > INPUT_BUFFER_CATCHUP_DEPTH` 8.

## Rendering

- `WebGPURenderer` is DEFAULT (`?legacygl=1` opts out); unavailable WebGPU retries `forceWebGL=true` before legacy, so TSL is the only shader path. WebGPU uses TerrainBackdrop's `fE` as per-vertex clip transform.
`ClusterLodMesh._render` fires once PER GROUP per frame: keep the `_lastRenderFrame===frame` early-return. `webgpu-hiz-shaders.js` HiZ cull must equal the CPU cull (divergence silently culls wrong cells).
- Veg LOD: `WebGPULodInstancer`'s oracle mirrors `updateLOD`; `lodEye` refreshes only after 0.5 m (`LOD_REEVAL_MOVE_SQ`). A leaf instancer is a SATELLITE of its branch (`opts.host`): `updateLOD` returns at once
- Default terrain FS is TSL, not `terrain.glsl`: `TerrainBackdrop.js` imports `mapspinner/src/tsl/planet-tsl.js` when `isWebGPU`. `terrain.glsl` = legacy `?legacygl=1` path + height-parity SoT (`gen-height.mjs` transpiles it); deleting it needs a new SoT + TSL/WGSL->JS generator. Every discard in it stays inside `#ifdef _WATERPASS_` (a discard disables early-Z depth write for all its draws); that rule governs the GLSL body only.
- `terrain-lighting-tsl.js` gates `sky.marchRadiance` on `apGate > 0` (`If(apGate.greaterThan(0.0), ...)` + `apTrans`/`apRad`), dropping march ALU + LUT fetches per terrain pixel; Terrain `renderOrder` 10 (`TERRAIN_DRAWS_AFTER_OPAQUE_OCCLUDERS`, `planet-tsl.js`) draws after opaque occluders (0 of 17 mapspinner tsl files use `discard`]: near-neutral. Water `WATER_DRAWS_BEFORE_OTHER_TRANSPARENTS` -1: shading always paid. `texFarFade > 0.001` (`surface-splat-tsl.js`) buys fetches for a 0.001 contribution. These are static per-pixel counts, not timings (s7).
- TSL `select` outside `uniformFlow` emits a real `if/else` (three's `ConditionalNode`), not a ternary: both sides are NOT evaluated.
- VDRS has no live consumer (zero `vdrs` under `packages/mapspinner/src/tsl`; the `TerrainBackdrop.js` branch is unreachable). `?legacygl=1` flips terrain hashVersion, so a legacy run isn't comparable to a TSL number.
- Dead per-pixel taps: `octFarFade` saturates at `reliefScale` 0.1 and its remaining taps are already gated (`surface-splat-tsl.js` gates `gFar`). `bandWarp` is NOT dead (`texFarFade` holds on nearly all terrain pixels): hoisting saves nothing (~0; s7).
- Legacy-vs-TSL: `terrain.glsl` mixes the raw interpolated vertex normal; TSL normalizes first (s7).
- `invertAcesFilmic` must NOT end in `max(x, 0)`: saturated blue inverts out of AP1/ACES gamut and clamping mis-encodes it (s7). Rendered sea = sphere R == `PlanetFrame.waterlineLocalY` to 1 cm; waves ZERO-MEAN.
- `ShadowPipeline.js forceUpdate` sets EVERY cascade's `light.shadow.needsUpdate`; `cascadeCount` clamps to 1 when `sun.castShadow===false` (cascade 0 IS the sun, never renders). `QualityPresets.js` ships `ssao`/`bloom` false.
- Vegetation `InstancedMesh2`: `sortObjects` stays false with LODs; `CullFreeze.js setInstancedCullAuto` sets `autoUpdate` on parent AND every LOD level. `model-pool.js` drains must allow >=1 unit/frame or a zero budget deadlocks.
- Veg + Rocks + `Grass.prewarm` budget WORK (`3384c0613f`): prewarm sums `loadChunk` durations, yields on a macrotask every 24 ms, reports `prewarmMs`/`prewarmWorkMs`/`prewarmChunks`. Boot effect: s11.

## Client and app runtime

- HUD `applyDiff(uiRoot, hudVdom)` replaces uiRoot children every frame; imperative DOM overlays mount on `document.body`.
- `_buildWorldScenery` is joinable: boot adopts a running build (`Promise.race` doesn't cancel the loser).
- `app.js animate()` returns early while `window.__warmupInFlight`; model-pool + streaming loads pump from frame jobs there, so never park a wait inside warmup.
- Client `WORLD_DEF` from `sendWorldDefAndModules` has `entities` STRIPPED and carries `_modelUrls`: derive world-entity facts from `_modelUrls`.
- Hot reload releases ctx via `AppRuntime._releaseAppContext`; `update()` keeps running with a torn-down ctx unless `_updateList`/`_rebuildCollisionList` are rebuilt.
- `AppRuntime._attachApp` does `apps.set` BEFORE awaiting `setup()`; `spawnEntity` attaches apps fire-and-forget: collect tagged entities on the first `update()` tick.
- `src/apps/CustomVersion.js`: `Reflect.set` is a deliberate raw write; a read must not reach the set trap and bump `_customV`.
- Spawn: `holdSpawnUntilGrounded` (`src/sdk/Relocation.js`) gates release on `terrainFieldMissingAt`/`coversPosition` (max `SPAWN_HOLD_MAX_MS=20000`); its `staticCollidersPendingNear` is true whenever `AppRuntime._pendingTrimeshBuilds.size > 0`, regardless of spawn point.
- Respawn clearance is shared: `AppGameplay.js pickSpawnPoint` + tps-game use one `footprintBlockers` sampler (17 down-ray columns; surface > `MAX_FOOTPRINT_INTRUSION_M` 0.15 m above a column bottom = `intruding`); `apps/tps-game/respawn-clearance.js` exports `spawnClearanceMarginM`.
- `BrowserServer.js`: `_lastTodSync` + `_deliveredWorldFingerprints` are MODULE level, so stall recovery + HostMigration rebuild a fresh BrowserServer in the same page.
- Singleplayer worker identity comes from `INIT.worldName`; the snapshot is one IDB key `world-snapshot` per origin.
- `FloatingOrigin.js update()` does `camera.position.set(0,0,0)` on rebase, not `+= -delta`.

## Measurement and witnessing

- Measured figures, refutations and instrument/adapter notes: `docs/measurement-figures.md` (struck values are replaced there).
- Per-pass GPU timings (`p50Ms`,`p95Ms`,`avgMs`) are INVALID as GPU-bound measures (lane a368d997: bimodal near-zero mode on the 30/60 fps arms, s0); a 0 duration is UNWRITTEN (65.5 us granularity). AMD iGPU: `--gpu-passes --extra=gputime=1 --backend=webgpu` works only after `npm run build:client` (FATAL otherwise) and is INVALID too. Quote no per-pass figure, select no arm by one, and never split stages with a `?gpuhide=` differential: sub-2 ms stages need in-run A/B on a fixed instrument.
- No `perf-run.mjs` instrument unlocks vsync (the flags live only in `frame-time-gate.mjs` behind `UNLOCK_RAF`, off at `SPOINT_UNLOCK_RAF=0`), so software rasterizers can't reach the frame-time floor. Baselines are per-vendor; an unbaselined vendor fails loudly.
- Pin each GPU arm's adapter: `vendorGpuArgs(vendor)` adds `--use-adapter-luid=0,<luid>` (`gpuLaunchArgs()` doesn't). Chrome ignores an unresolvable LUID while reporting accelerated, so assert `window.__rendererInfo`'s renderer string; never mint a WebGL2 context in a measured page. AMD frame-time verdicts need a quiet window: `gpulock` serializes the adapter, never the CPU (a settle probe under 40 frames/2000 ms = box busy; `scripts/lib/host-contention.mjs` can't see GPU-side contention). The contention gate needs a GPU-bound control page and writes no slower baseline without `--accept-slower=<reason>`.
- Decide perf rows on counted work units: a never-incremented counter is a silent pass, so confirm the field exists on the measured backend (`vegProfile.meshInstances` is absent on `WebGPULodInstancer`). Authoritative draw count = `drawsInstrument.authoritativeField` (`wgpuDrawsPerFrame` / `glDrawCallsPerFrame`); WebGPU `info.render.calls` is cumulative.
- Toggles: `?lightplanet` stubs the planet but keeps the height sampler + foliage; `?veg=none`, `?nograss`, `?norocks` are real. `window.__vegAllOff` (read in `client/core/Vegetation.js`) kills foliage per frame; no per-part app toggle. 
- `perf-run.mjs`: `?gpuhide=`/`?gpuab=<name>` (boolean), `?gpuabms=<ms>`; `--knob=<key>=<value>[,...]` (`?knob=` in `--extra`; number or boolean). Keys are registry `key`s verbatim (`maxLevel`, not `__maxLevel`), set at document start by a setter trap on `window.__renderControls`. A pre-boot reject names the key; one bad key fails the run. Limits: `maxLevel` 2..22, `splitFactor` >= 0.05.
- `dprAuto` defaults `false` (`client/core/RenderControls.js`), matching every preset; `FrameMetrics.js` reads it via the registry, so a bypassing run starts adaptive pixel ratio if the default flips — measuring arms pass `--knob=dprOff=true`. `window.__dprAuto`/`__dprOff` no longer exist (0 writers/readers under `client/`; `_publishDpr` deleted).
- QualityGovernor drives only GOVERNED_KNOBS (ssao, bloom, ssr, vegLeafOff, maxLevel, splitFactor) and throws if a driven key is in RESOLUTION_KEYS (`dpr*`, `vdrs*`, `threeVdrs*`, `fsr1*`, `vdrsUpscaleFsr1*`, `halfResWater`, `bloomResolutionScale`): no pixel doubling. Live only when `qualityGovernor===true && qualityGovernorOff!==true`.
- `halfResWater` reads as `=== true` (`gl-render.js`), so unset = OFF, matching the `RenderControls` default `false`; a consumer with no preset keeps full-frame MSAA. Its water-occlusion branch needs `window.__planetDepthToCanvas === true`, set only by `client/core/TerrainBackdrop.js` (`_hrwActive` is always true at ground level, so planet depth never reaches the canvas).
- An untagged template literal turns a lone `\d` into `d`: write `\\d+` (`?gpuabms=` was inert through `3384c0613f` for this).
- WebGPU parity: a region matches iff cross-renderer meanAbs/channel <= 3 x max(same-renderer noise floor, `QUANT_FLOOR`); establish the same-code floor first (s8).
- `prediction-drift-witness.mjs`: `--server-tick=<hz>` is its only lever; at 10 Hz the floor is one 100 ms step, so raise caps.
- CDP `Input.dispatchKeyEvent` reaches the app input bucket (`window.__app.sentInput`); keyboard sets `input.backward`, never `input.back`. `[physics] peak active 0` doesn't mean a stalled player (`CharacterVirtual` isn't counted by `GetNumActiveBodies()`).
- A witness with a fixed scratch dir must `rm` it at start (a gate killed at its 120 s cap leaves it; later runs hang). `gm exec_js` dispatches are ephemeral; use `127.0.0.1`, not `localhost`. Headless Node witnesses building `PhysicsNetworkClient` polyfill `globalThis.WebSocket` from `ws`. `edge-collider-draco-witness.mjs` rewrites tracked `apps/tps-game/*.glb` in place: never run it in a gate.

## Security

- Re-run the dependency scan on any fresh or updated `node_modules`.
- `SESCompartmentEvaluator.js` is the only untrusted-app evaluator and fails closed (`SandboxUnavailableError`); `StaticHandler` enforces path containment + COEP `require-corp` (`DevHmr.js` sets it too). A failed `import('ses')`/lockdown throws: ses is only in optionalDependencies, so a skipped optional install disables the sandbox.
- `authCompare.js timingSafeTokenEqual` self-compares (`bufA,bufA`) on a length mismatch so token length isn't leaked: don't simplify it away.
- Benign exec surfaces, never flag as malware: `lang/spoint.js`, `mapspinner/planet.html`, `scaffold.js`, `cdp-browser.mjs`.
- Witness CLIs taking `--module=<path>` (the EcsQuery witness under scripts/) load that path as code: point them only at trusted files.

@.gm/next-step.md
