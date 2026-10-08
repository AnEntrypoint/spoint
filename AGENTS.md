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

## Working rules

- Commit as lanmower, main-only, `git_commit` explicit `paths`; pathless `git_finalize` sweeps another lane's edit. Push `git_push {rev:"HEAD"}`; bare `git_push {branch:...}` gate-denied while foreign dirt exists. `amend` amends now (refuses pushed HEAD) but cannot strip CR from a landed CRLF blob — repair = `git_reset_head` + re-commit.
- `.git/index.lock` present fails `git_commit`; foreign stalled git holds it 20+ min — confirm via `Get-CimInstance Win32_Process`; 0-byte lock + no spoint git alive = removable.
- Generated artifacts ship with source: `AppContext.js` -> `sdk-typings.generated.d.ts`; height-code change re-bakes `apps/world/*.hf`.
- `check-cache-keys.mjs` shared: editing another transform's `BAKE_INPUTS_*` reddens `npm run check` every lane until `cacheCodeVersions.js` pin bumps in same commit. `check.mjs` parses TRACKED files only. A `BAKE_TRANSFORMS` entry (`BakeCodeVersion.js`) names narrowest module transform reads, not its import closure.
- `core.autocrlf=true` lives only in SYSTEM config, so gm's git missed it until host stopped blanking global config for `add`/`status`/`diff`/`checkout`/`commit`/`stash`; 211 files are index-LF + worktree-CRLF, each a false-`modified` candidate. `w/crlf` in `git ls-files --eol` = no diff; a CRLF blob renders as one whole-file rewrite in `git show` (`43097ece`, `e233212d`: 11+/5- -> +122/-122). Verify with `git ls-files` + `git hash-object --path`, not verb's `removed`/`staged`.
- `.gitignore` re-includes `.gm/*` only under `.gm/memories/` + `.gm/disciplines/project/`; other `.gm/` paths uncommittable silently.
- Untracking: gm `git_rm {"cached":true}` + paths-scoped `git_commit` (`index_commit:true`) with byte-identical `git ls-files` paths; any other spelling re-adds. `git_reset {paths}` path-scoped; bare `git_reset {}` refused.
- gm MCP = HTTP, not stdio (`http://127.0.0.1:8787/mcp`); Claude Code connects once, never retries — startup gap detaches it for the session; recover via `/mcp`. CLI `gm-dispatch.mjs <verb> '<json>'`; a body with backslashes is mangled by shell — file it, pass `"$(cat file)"`.
- `@spoint/ecs` resolves only via `@spoint/*`; link vanishes mid-session and kills every harness — `npm run links` restores, never `npm install`.
- `scripts/gpulock.mjs run <owner> -- <node> <script>` serializes accelerated arms via `.gpu-lock/owner.json`; ADAPTER only, never CPU; exits 0 even when witness failed, so grep the log for `RESULT:`.
- Never `git worktree remove` a `scripts/worktree-setup.mjs` worktree (node_modules junction deletes `node_modules/.bin`); use `scripts/worktree-teardown.mjs`.
- gm spool `in/<verb>/<session_id>-<random8>.txt`: write sibling `.tmp`, RENAME onto `.txt`; straight write dispatches a torn body.
- CI: completing jobs = `check` + `frame-time-coverage`; `frame-time` carries `if: vars.CI_GPU_RUNNER_ONLINE == 'true'`, so no runner + var unset = SKIPPED. `concurrency` group PER SHA; CI Node 20 vs box Node 24.
- `npm run check` (gpu-free arm -> `fire-witness-gate.mjs` -> `check-frame-time-baselines` -> opt-in `SPOINT_GPU_WITNESS`) parses only tracked `src,client,apps,scripts,bin`, refuses browser/GPU witnesses by name; witness must exit 0 AND print `RESULT: PASS`, pinned to a `must:` regex.
- Gpu-free admission by capability, not cost: witness belongs iff it needs no browser + no GPU context.

## Repo boundaries

- `design` ships as pinned CDN URLs in `client/{index,landing/index,editor/thebird-host}.html` + `scripts/bundle-client.mjs`. `vendor/*` editing-only submodules.
- `apps/*` never imports `client/*` (singleplayer Worker resolves relative specifiers vs virtual root); expose utilities on `engineCtx`.
- Keep Node-only dynamic import specifiers opaque to esbuild/wrangler: build in IIFE, `(() => './' + 'ServerAPI' + '.js')()`. `edge/cf-do/spoint-do.js` imports `jolt-edge-init.js` BEFORE `WorkerEntry.js`.

## Debugging discipline

- Bug surviving a threshold change is not fixed; re-diagnose.
- `spatial.mutations` is stable in a quiescent world (`SpatialIndex.update` skips under `distSq < 1.0`, `Octree.js:65`); do not assume a mutation-keyed epoch changes per tick.
- A cause stated in a report is a claim, not a fact, until someone instruments it: a PRD row blaming per-tick `spatial.mutations` was filed unchallenged this session and disproved by the live window. Fixing a failure end-to-end at its own layer = second copy of same check (`ShapeBuilder.js`, `cluster-lod-mesh.js`).
- **Silent-no-op class**: a knob with no consumer, or whose enable bit defaults off, reads as a working lever, so measuring through it measures nothing: `?noveg`, VDRS `__vdrsScale`, `?legacygl=1`, `u.fsCheap`, `perf-run.mjs inputReachedGame`, `perf-run.mjs --no-walk` (a static arm reads ctx0 p50 0.1311 ms against a 33.22 ms wall frame; use walking arms for GPU timing). Codesearch a knob's reader + enable bit before trusting it.
- libuv `uv_async_send` assert fires at `process.exit()` with handles mid-close; headless scripts await `process._getActiveHandles()` hitting 0.
- Witness needing server to act on a client message passes `--params=multiplayer`; `?singleplayer` sees `players:0`, acks `ok:false`. A harness returning uncompared `{expected, got}` passes either way: one `expect()` per measurement, non-zero exit.
- One `gl.getError()` code covers distinct bugs (1282 = feedback-loop, sampler-type-mismatch AND insufficient-buffer-size): read the driver's own console string off a cache-disabled reload.
- Live GL: all `window`/`document` access through `page.evaluate()` in a capture-prefixed script; pin file:line via `addInitScript` wrapping `drawElementsInstanced` to drain-then-check `gl.getError()`; editor via `app.clientMachine.send('TOGGLE_EDITOR')`.
- Troubleshooting `scripts/lib/`: `head-vs-worktree.mjs <paths>`, `gm-dispatch.mjs <verb> [body]`, `witness-audit.mjs`.
- `witness-audit.mjs --gate` = gpu-free arm of `npm run check`: per-file per-check counts vs committed `.witness-audit-baseline.json`; fails on absent check id or count above it.

## Entry points

- `ctx.defineGameFSM(spec)` `src/behaviours/game-fsm.js`; `ClientMachine.js` xstate5 parallel, fallback `after:` 10 s gated / 45 s hard stop.
- `ctx.defineFire(spec)` `src/behaviours/fire.js` (wired at `src/apps/AppContext.js:387`, default off).
- Test relocation: `window.__spoint` + `MSG.TELEPORT` (0xc2 / ACK 0xc3, `src/sdk/Relocation.js`; no `EDITOR_TOKEN` = any client, `relocation:false` disables, >87 deg refuses). `window.__spoint._drive` = `Relocation.js drive()`.
- Client app's `ctx.state` = entity `custom` block (`AppModuleSystem.js`), not server app state: `ctx.state.<key> ?? literal` takes the literal forever. `engine.cam` = camera CONTROLLER, no `position` — read `engine.client.getLocalState().position`.
- Wireweave attach helpers run after awaits (host migration reassigns `client` in `app.js`): re-check at call time.
- `createServer()` per-call factory; `boot()` SIGINT/SIGTERM handlers process-global: stop with `RoomDirectory.stopAll`.
- Remote server's `netcode.profile` named only when client = real `PhysicsNetworkClient`: boot that witness on `?connect=...&multiplayer=1`, else it falls back to in-page `BrowserServer`.

## Fire

- Integer-only kernel `fireKernel.js`: decisions from `hash(seed, step, face, I, J)`, no float / `Math.random` / `Date.now`.
- Rain smothers, does not eat fuel: a rain-suppressed cell still burns `burnRate`, pushes no heat, spots nothing (`fireKernel.js burnCell`). `rainPerIntensity` (255, `fireSpec.js`) maps intensity 0..1 to a roll byte.
- `ctx.navCostAt(x,z)` = 8 burning / 2 charred; `canSee` smoke-gated via `_fireNavByRuntime` at depth >= `smokeBlockDepth`.
- Wind = weather vector (BASE) + `hash(seed, step)` gust, clamped +-16 per axis; `snapshot().wind` carries BASE only.
- Per-cell initial fuel not recomputable in kernel (`classify()`, `VegPlacement.js`); a per-tile array added to `snapshot()`/`restore()` joins `TILE_ARRAYS` (`fireKeyframe.js`) + VERSION bump.
- Tampered keyframe rejected at DECODE, named `[fireKeyframe]` error. `G` = ignition step mod 256, not age; IGNITE_AREA kind 5.
- Boundary snapshot's `delta` rolls back step BEFORE it (`takeDelta` at t=K reads `preStep` captured at K-`stepTicks`); restore verifies against boundary's `counters`, never its `delta`. `adopt`/`rewindTo`/`submit` return `{ok, reason, detail}`.

## Planet-wide multiplayer

- One server world per cluster, each own flat chart. Jolt heap fixed `JOLT_WASM_HEAP_BYTES` 134217728 B (`src/shared/clusterConfig.js:8`), never grows; over it `new J.JoltInterface` raises `Aborted(OOM)`.
- Three limits, not one cap: `maxContactConstraints` under requirement drops contacts silently; `maxBodies` under population makes Jolt return body id 0, so overflow bodies share one map key and `destroy()` aborts wasm.
- Assignment pure, hysteretic, antipodal-safe, 2-4 Hz; `resolveClusterConfig` refuses a link below relevance ring or longest weapon range.
- Collider rings (`ColliderStreamer.js`): `DEFAULT_MAX_CENTERS = 192` for BOTH trunk + rock streamers; rings per connected player, never centroid. `classifyRings` per-cluster quota resets every pass, first-fill, no guarantee; `evictOverCap` farthest-first.
- `clusters` occurs 0 times under `apps/`, so `resolveClusterConfig` (`clusterConfig.js:35`) returns `null` for every shipped world — planet-wide multiplayer dead, not untested. `planetRadius` 0 in every shipped world too (`Stage.js:8` = `config.planetRadius || 0`), so cube-sphere branches (`resolvePlayerCell`, `solveCellViewer`, `computeRingRelevantIds`) never execute: only flat ring path is live or covered.
- Flat AOI query is HORIZONTAL (`Octree.js:111` `nearbyHorizontal`, `Stage.js:61` `getRelevantEntitiesHorizontal`, `StageLoader.js:110`, chosen at `TickHandlerAOI.js:132` when `planetRadius <= 0`), not height-tracking, because ring has zero vertical slack: a cell centre sits exactly `relevanceRadius` from each edge-neighbour centre, so any vertical component excludes every entity.
- `checkSlices` (`worldResolve.js:33`) rejects non-positive-finite `planetRadius`; `StageLoader.js:20` throws when a radius is declared without enabled clusters. `StageLoader.js:15` runs `resolveClusterConfig` on EVERY load, so six `ClusterConfigError` codes (`clusterConfig.js:38,43,44,46,48,50`) can throw at boot and on hot reload with no stage-specific catch — latent, no shipped world reaches it.

## Chart re-anchor

- Chart-local server holders migrate via `src/sdk/chartState/` (`attachServerChartMigrators(ctx, service)`). Re-anchor = change of basis, not rotation: position/velocity/forward invariant. CHART_REANCHOR = 0xc6.
- Flat chart's intrinsic tilt fixed by shrinking the chart: `CHART_ANCHORS_PER_FACE = 32`. `CHART_REANCHOR_ANGLE_DEG` (28 / 14) must exceed worst angle of its `createChartAnchorLattice` or the anchor thrashes.
- Exactly ONE chart per world; two players at separation Delta sit at Delta/2, walkable iff `terrainTilt + Delta/2 <= 45 deg`.

## Physics and Jolt

- `physics.setBodyMotionType` returns NEW body id or `false`; a Static-created body cannot be made to simulate by `SetMotionType` at all, hence recreation. `IsActive()` only discriminator — `GetMotionProperties()` non-null even on a static-created body.
- Recreation creates new body BEFORE destroying old, on `LAYER_DYNAMIC`, refusing a body holding constraint, vehicle chassis or trimesh/mesh/heightfield shape.
- Pooled body whose `bodyMeta.type` != requested motionType is destroyed + replaced (pool key = model|scale only); matching slot revives via `_revivePooledBody`; `removeBody` on pooled DYNAMIC does `DeactivateBody` + zeroes both velocities.
- `BodyInterface.GetPosition` returns ONE shared temp, so two calls alias — `addConstraint` reads default anchors via `getBodyPosition`. Jolt recycles removed bodies' tree nodes only in `physics.step`: re-adding thousands of bodies with no step between aborts wasm.
- Jolt `HeightFieldShape` exposes `GetMinHeightValue()`/`GetMaxHeightValue()`/`GetSampleCount()`, NOT `get_mMinHeightValue`; `GetSampleCount()` = PER-SIDE count (N), not N*N.
- Trimesh/convex collider build failure in `src/apps/AppPhysics.js` PROPAGATES as `ColliderBuildError`, never degrades to a 0.5 m box; `AppRuntime` `config.autoTrimesh` branch + `EditorHandlers.js` still box.
- `AppRuntimePhysics.js` skips `e._vehicleId != null` in BOTH `_tickPhysicsLOD` + `_enforceBodyBudget`. Height samples snap to 1 mm via `+ 0`: `Math.round` of a negative sample yields -0; -0/+0 differ as `Float32Array` bits.
- `VehiclePhysics.js`: never `J.destroy` `v.constraint`/`v.tester` after `RemoveConstraint`, never destroy `get_mTracks()` copies after `set_mTracks`; empty `mDifferentials` = zero wheel torque.
- EDITOR_UPDATE calls `syncEntityCollider` AFTER `changeBodyType` (which removes the body and clobbers `custom._collider`).

## Terrain and colliders

- `solveSurfaceY` tolerance absolute `1e-4` (`SURFACE_SOLVE_TOLERANCE_M`, `PlanetFrame.js`), 64-eval cap, throws `SurfaceSolveError`; past 63.6 km returns `-(R+anchorHeight)`, NO throw.
- Baked heightfield FAIL-LOUD (`src/terrain/TerrainPhysics.js`): absent = silent CPU fallback; unreadable/truncated/bad-magic/stale-code throw named `[baked-heightfield]` error. A `hashVersion`/`terrainKey`/`chartEpoch` mismatch warns + falls back.
- No terrain FATAL: `ServerAPI.loadWorld` rethrows `[terrain] world "<id>" has no terrain`; every caller stops server it created first.
- Two height backends; v2 = parity backend, carves (`terrainCarvesOf`) v2-only. v2 mean 0.001/max 0.005 m vs v1 mean 1.288/max 2.840 m.
- `elevationAtLocal(frame,x,y,z)` is exactly `|p|-radius`; app-facing `ctx.terrainHeightAt` is NOT that.
- `PlanetFrame.groundHeightLocal` caches in 4096 direct-mapped slots keyed by EXACT `(x,z)` + chartEpoch (memoising `SurfaceSolveError` too).
- `terrain.glsl` `snoise3`/`vnoise2`/`seaHash`/`hpfSample` take in-cell fraction as `P-floor(P)` from ONE `floor`.
- Server terrain collider lives in ONE fixed-anchor local tangent plane (`anchorDir` default [0,1,0]): cannot represent directions past ~87 deg from anchor.
- `gl-render.js sampleGroundM` fire-and-forget async (PBO+fence): each call returns PREVIOUS call's harvested height; non-rAF callers use `sampleGroundMSync`, which poisons next async collision read.
- `VegPlacement.js`/`RockPlacement.js` read climate before `surfaceOfCell` only when `climateUsesLocalXZ !== true`. Veg density must gate on painted snow, else surviving grass weight roots trees.
- Snow resamples only after >0.1 m drift (`SNOW_GROUND_RESAMPLE_DRIFT_M`, `Weather.js`): 229 -> 46 samples/update.
- REFUTED, do not retry blind: 2-tap forward difference in `src/terrain/PlacementChart.js radialSlopeAt` — gradient crosses `SLOPE_MAX` 0.6, flipping gate decisions.

## Netcode and wire

- Prediction suppresses only blocked DIRECTION: `_reconcile` (`PredictionEngine.js`) derives `wedgeNormal` from commanded-vs-achieved motion, else `-velocity` when stopped while commanding; `shared/characterStep.js` projects out that component alone.
- Client peer separation is a win (`CollisionSystem.js applyPlayerCollisions` pushes overlap/2 per tick): 0.1943/0.2049 corrections per ack vs 0.7422.
- `msgpack.js` `WIRE_STRUCTURES[1]` lists exactly the keys, in order, of `TickHandler.js _packPayload` (seq,tick,serverTime,players,entities,removed,delta,dots). msgpackr 2.0.4 writes -0 as `0x00`; `patch-deps.mjs` excludes -0 from both integer tests. Raw ws clients must mirror `COALESCE_SENTINEL`/`splitCoalesced`: `0xFF` then `[uint32 LE length][msgpack]`.
- Wire v3 player record: 8 fields in 22-byte bin; `[inputSequence, inputBuffer, groundNormal]` ride a per-recipient `me` block, so snapshots pack per recipient. `getSnapshot()` keys on `_version === _snapshotVersion` alone.
- `PhysicsNetworkClient.connect()` REJECTS, named `TransportConnectError` (`err.reason`: `websocket-unavailable`/`-error`/`-closed-before-open`, `connect-superseded`), not `connected:false` + no socket; retry belongs in caller (`_doReconnect`), never in fake success.
- `SnapshotGroupPlanner`: groups = `ceil(viewers*perViewerMs/(budgetMs-fixedMs))`, budget = tick period * `SNAP_COST_HIGH_FRAC` 0.35 (`TickHandler.js:30`). `relevanceRadius` IS set by worlds (`src/presets/tps.js:5` 200, `apps/world/construct.js:20` 100), so interest management LIVE there; `getRelevanceRadius` (`src/sdk/server.js:79`) falls back to 0 only where a world omits it.
- Lockstep: rollback input-capped, so measure by depth, not rate (`maxRollbackTicks` 12); `inputDelayTicks` above `INPUT_RETAIN_TICKS` (240) throws at construction.
- Socket becomes a player by MIGRATE, RECONNECT, or silence past MIGRATE-peek grace (`ServerHandlers.js onClientConnect`, 50 / 1500 ms dilated) — a silent probe joins as a phantom, so probes use `?probe=1`. Never answer an unresolvable RECONNECT with INVALID_SESSION and leave it open: `rejectSession` flushes + closes.
- Migration keeps old transport as fallback owner, hands player back on candidate death; a close from a transport client no longer owning cannot tear it down.
- Authoritative path: prediction off by default (`?predict` only); rollback/lockstep unwired. `TickHandler.js processPlayerMovement` takes ONE input per tick, catching up only while `inputs.length > INPUT_BUFFER_CATCHUP_DEPTH` 8.
- `BaseClient.js sendInput` stops feeding `predEngine.addInput` once `predictionLeadSteps()` reaches `MAX_PREDICTION_LEAD_STEPS` 16; a fast client degrades to bounded lead.

## Rendering

- `WebGPURenderer` DEFAULT (`?legacygl=1` opts out); unavailable WebGPU retries `forceWebGL=true` before legacy, so TSL is only shader path. WebGPU uses TerrainBackdrop's `fE` as per-vertex clip transform; WebGL only for CPU frustum culling.
- `three.webgpu.js` drops pending `popErrorScope()` rejections at 3 sites; `patch-deps.mjs` patches all three. `ClusterLodMesh._render` fires once PER GROUP per frame: keep `_lastRenderFrame===frame` early-return. `webgpu-hiz-shaders.js` HiZ compute cull must equal CPU cull: divergence silently culls wrong cells.
- Veg LOD: `WebGPULodInstancer` oracle mirrors `updateLOD` — `lodEye` refreshes only after 0.5 m (`LOD_REEVAL_MOVE_SQ`). A leaf instancer is a SATELLITE of its branch (`opts.host`): `updateLOD` returns immediately, tier/shadow/visibility mirrored.
- Every discard in `terrain.glsl` FS stays inside `#ifdef _WATERPASS_` (a discard anywhere disables early-Z depth write for all its draws). It is SoT for CPU/GPU height parity (`gen-height.mjs` transpiles it); deleting it needs a new SoT + TSL/WGSL->JS generator.
- Default-path terrain FS is TSL, NOT `terrain.glsl`: `TerrainBackdrop.js:43` imports `mapspinner/src/tsl/planet-tsl.js` when `isWebGPU`. `terrain.glsl` = legacy `?legacygl=1` path + height-parity SoT, so its `_WATERPASS_` rule governs GLSL body only.
- Counted per pixel on live TSL path (static count, not a timing): LAND = 9 `snoise3` (~900 ALU) + 19-31 fetches, 12-24 triplanar from a 1024^2 4-layer RGBA8 mip set at `anisotropy = 8` (~43 MB, past an iGPU cache). WATER = 77-107 `seaOctave` (~5-7k ALU) = 5-7x terrain/px, yet measured ~0 (terrain occludes). VS = 240 `snoise3`/vertex (`FD_TAPS` 5).
- `terrain-lighting-tsl.js` NOW gates `sky.marchRadiance` on `apGate > 0` (`e233212d`): `If(apGate.greaterThan(0.0), …)` + `apTrans`/`apRad` drop march ALU and its 6 LUT fetches per terrain pixel (`sky-tsl.js:89`); `mix(lit, hazed, 0) === lit`, so bit-identical. Terrain `renderOrder` 10 (`TERRAIN_DRAWS_AFTER_OPAQUE_OCCLUDERS`, `planet-tsl.js`) draws it AFTER opaque occluders, maximizing early-Z rejection (no `discard` in `packages/mapspinner/src/tsl`, 0 of 17 files); near-neutral, not a win — do not "fix" by drawing terrain first. Water `WATER_DRAWS_BEFORE_OTHER_TRANSPARENTS` -1: shading always paid. `texFarFade > 0.001` (`surface-splat-tsl.js:133`) buys 12-24 fetches for a 0.001 contribution.
- TSL `select` outside `uniformFlow` emits real `if/else`, not a ternary (three's `ConditionalNode`) — both sides NOT evaluated.
- VDRS has NO consumer on live path: `packages/mapspinner/src/tsl` has zero `vdrs`, and VDRS branch in `TerrainBackdrop.js` unreachable. Consumers read `__vdrsScale` ONLY when `window.__vdrs === true` (default false), so scale is set without the enable bit.
- `?legacygl=1` silently drops unless in-page server (`app.js:191`): needs `?singleplayer&legacygl=1` and flips terrain hashVersion, so a legacy run NOT comparable to a TSL number. `u.fsCheap` swaps `outputNode` only: not a valid FS probe. Terrain `side = DoubleSide` (`terrain-material-tsl.js:198`): no backface culling.
- Dead per-pixel taps: `octFarFade` saturates at `reliefScale` 0.1, but only 6 fetches removable — `surface-splat-tsl.js:116` already gates `gFar` fetches and `albNear`'s 3 taps feed `disp` -> `pool`/`finger`. `bandWarp` NOT dead: `texFarFade` holds on ~100% of terrain pixels, so hoisting it saves ~0.
- Legacy-vs-TSL: `terrain.glsl` mixes raw interpolated vertex normal while TSL normalizes first; `reliefShade` 6 amplifies 0.53/0.73 into a 3.11/5.67 delta.
- `invertAcesFilmic` must NOT end in `max(x, 0)`: saturated blue inverts to (-0.034,0.346,1.395), out of AP1/ACES gamut; clamping re-encodes 82.7 vs 55.9. Rendered sea = sphere R == `PlanetFrame.waterlineLocalY` to 1 cm, waves ZERO-MEAN.
- `ShadowPipeline.js forceUpdate` sets EVERY cascade `light.shadow.needsUpdate`; `cascadeCount` clamps to 1 when `sun.castShadow===false` (cascade 0 IS the sun, never renders). `QualityPresets.js` ships `ssao`/`bloom` false.
- Vegetation `InstancedMesh2`: `sortObjects` stays false with LODs; `CullFreeze.js setInstancedCullAuto` sets `autoUpdate` on parent AND every LOD level. `model-pool.js` drains allow >=1 unit/frame or a zero budget deadlocks.
- Veg + Rocks + `Grass.prewarm` all budget WORK (`3384c0613f`): prewarm sums `loadChunk` durations, yields on a macrotask every 24 ms, reports `prewarmMs`/`prewarmWorkMs`/`prewarmChunks`; rAF was the wrong yield (display-owned, throttled in a hidden tab). AMD tps-game median boot-to-playable 12623 -> 11622 ms.

## Client and app runtime

- HUD `applyDiff(uiRoot, hudVdom)` replaces uiRoot children every frame; imperative DOM overlays mount on `document.body`.
- `_buildWorldScenery` joinable wrapper; boot adopts a running build (`Promise.race` does not cancel the loser).
- `app.js animate()` returns early while `window.__warmupInFlight`; model-pool + streaming loads pump from frame jobs there, so never park a wait inside warmup.
- Client `WORLD_DEF` from `sendWorldDefAndModules` has `entities` STRIPPED, carries `_modelUrls`: derive world-entity facts from `_modelUrls`.
- Hot reload releases ctx via `AppRuntime._releaseAppContext`; `update()` keeps running with a torn-down ctx unless `_updateList`/`_rebuildCollisionList` are rebuilt.
- `AppRuntime._attachApp` does `apps.set` BEFORE awaiting `setup()`; `spawnEntity` attaches apps fire-and-forget, so collect tagged entities on first `update()` tick.
- Spawn: `holdSpawnUntilGrounded` (`src/sdk/Relocation.js`) gates release on `terrainFieldMissingAt`/`coversPosition` (max `SPAWN_HOLD_MAX_MS=20000`).
- Respawn clearance shared: `src/apps/AppGameplay.js pickSpawnPoint` + tps-game use one `footprintBlockers` sampler (17 down-ray columns; surface > `MAX_FOOTPRINT_INTRUSION_M` 0.15 m above a column bottom = `intruding`).
- `BrowserServer.js`: `_lastTodSync` + `_deliveredWorldFingerprints` MODULE level — stall recovery + HostMigration rebuild a fresh BrowserServer in same page.
- Singleplayer worker world identity from `INIT.worldName`; snapshot = one IDB key `world-snapshot` per origin.
- `FloatingOrigin.js update()` does `camera.position.set(0,0,0)` on rebase, not `+= -delta`.

## Measurement and witnessing

- Every figure below must be traceable to a witness. Rows tagged `p50-derived` rest on per-pass `p50Ms`, which COLLAPSES toward 0 on any arm reaching vsync cap (ctx0 p50 0.131 vs p95 26.35; p50/p95 0.00-0.63 on 9 of 11 AMD WebGPU arms), so a `?gpuhide=` differential is healthy-minus-collapsed and INFLATES what it hides: do not quote a `p50-derived` figure until re-derived where hidden arms stay GPU-bound. The ctx0 resolution sweep is a separate instrument, unaffected.
- In flight, not landed: the GPU-pass instrument is being changed to classify each timestamp query `resolved`/`unresolved`/`inverted`/`unverified` and tally only resolved ones, replacing the `setInterval` drain with an rAF pump + modal per-frame filter — it targets queries read before they resolve. Nothing above is re-derived against it: caveats stand until a re-derivation exists, and the re-derived number replaces the struck one rather than leaving a hole.
- Every named GPU arm pins its adapter: `vendorGpuArgs(vendor)` adds `--use-adapter-luid=0,<luid>`; `gpu-probe.mjs gpuLaunchArgs()` does NOT. Pinning necessary, NOT sufficient — Chrome ignores an unresolvable LUID while reporting accelerated, so assert the renderer string.
- REFUTED: AMD iGPU does not lose GPU context at boot; hang was `probeGpu()` minting a fresh WebGL2 context in measured page — it now reads `window.__rendererInfo`. Never mint a context in a page you measure.
- Software rasterizer cannot reach gate floor, so frame-time arm needs accelerated runner. Vsync-locked p50 = refresh divisor, not work; `frame-time-gate.mjs` unlocks rAF. Baselines PER-VENDOR (another adapter's refused; unbaselined vendor fails loudly): AMD 18.39 ms `ee756369`, NVIDIA 9.03 ms `76059b48`.
- AMD iGPU DOES expose `timestamp-query`, so `--gpu-passes --extra=gputime=1 --backend=webgpu` works (`npm run build:client` first or FATAL): 1080p GPU p50 25.36 ms vs 15.88 ms CPU = GPU-bound; NVIDIA 5.18 ms, vsync-locked, NOT GPU-bound. Per-pass `avgMs` DRAIN-BIASED 25-36% low — quote `p50Ms` with `p95Ms` beside it, never avg — re-derive pre-`52b09a09` per-pass averages.
- Resolution sweep, NOT p50-derived: ctx0 = 6.607 + 8.665·Mpx, R² 0.9904 — 4.00x fewer pixels moves ctx0 13.11 ms, but 6.61 ms (26.7%) does not scale.
- `p50-derived` per-stage split (`?gpuhide=`/`?gpuab=`, `52b09a09`), AMD 1080p ctx0: sky 1.38, trees 0.33, grass 0.33, rocks 0.10, residual 1.90, water ~0; ctx2 shadow 0.131, ctx1 composite 0.393. Vegetation sits inside noise.
- `p50-derived` `?gpuhide=terrain,water` puts whole fixed floor in terrain: terrain = 6.27 + 4.34·Mpx vs 1.03 + 4.09·Mpx rest, i.e. 9.00 ms fragment + 6.27 ms fixed at 1080p. Cutting terrain geometry ~80% (`__maxLevel` 11 -> 2, ~41k -> ~8k vertices) moved ctx0 +0.26/+0.45 ms (~0.2x noise) while CPU frame wall halved 33.07 -> 16.70 ms; what that refutes unset, since 6.27 ms floor may itself be a p50 artifact.
- `p50-derived` NVIDIA: planet = 8.6 of 11.0 ctx0 (78%), same 78% as AMD, so RATIO holds — but NVIDIA ABSOLUTE ms NOT comparable across sessions (2.3x shift vs its own 5.18 ms control), and its per-arm split does not close additively (terrain+sky 9.9 > planet 8.6). AMD absolute ctx0 SESSION-LOCAL: 15.93 vs 24.77 ms at 1080p across sessions — compare within a session.
- `p50-derived` Unresolved: vegetation costs 0.33 ms planet-on but 3.21 ms planet-off, same ~130k triangles — never quote one cost without the planet state.
- Planet + foliage toggles: `?lightplanet` stubs planet, keeps height sampler + foliage; `?veg=none`/`?nograss`/`?norocks` real; **`?noveg` is NOT a flag** — no-ops silently. `window.__vegAllOff` kills foliage per frame; no per-part app toggle. `perf-run.mjs` supplies `?gpuhide=`/`?gpuab=<name>` (boolean only) and `--knob=<key>=<value>[,...]` (`?knob=` in `--extra`) for number + boolean knobs; keys = registry `key`s verbatim (`maxLevel`, not `__maxLevel`); injected document-start as a setter trap on `window.__renderControls`, so `registry.set` fires as `installRenderControls()` assigns it, before boot-time reads; rejects pre-boot naming the key (unknown, out of range — `maxLevel` 2..22, `splitFactor` >= 0.05 — wrong type, no `=`); one bad key fails the run. AMD noise +-1.3 ms planet-ON, +-0.2 ms planet-OFF: sub-2 ms stages need in-run A/B.
- `?gpuabms=` WAS inert through `3384c0613f`, not merely CLI-dropped: `perf-run.mjs:277` sits inside `GPU_PASS_ARM_SRC` untagged template literal (opened :261), where a lone `\d` is a NonEscapeCharacter evaluating to `d`, so regex reached the page as `(d+)`, never matched, `abPhaseMs` always 5000; on-disk source read `\d+`, so review could not see it. Fixed by writing `\d+` — uncommitted in the working tree (now :301), so re-check the line before trusting the flag. `?gpuab=<name>` was never affected.
- RenderControls registry audit, static classification of the working tree, NOT a live-page witness: 35 keys read only from `gl-render.js`/`planet-orchestrator.js`, reachable solely via `?legacygl=1` (`app.js:190-193`, `TerrainBackdrop.js:46-47`), so `--knob` on any of them writes a global nobody consumes and reports a clean null result — same shape as terrain-VDRS false negative. Only `splitFactor`, `maxLevel`, `distFactor`, `geomorphLod`, `wetness` live on default path; `fsCheap`/`vsCheap`/`octMax`/`fsDetailOcts`/`nrmStepM`/`waterVisGate` legacy-only (`fsCheap` read only at `gl-render.js:619`). `elevEdgeInset` has NO consumer: documented reader `gl-render.js _collectElevEdgeSample` does not exist; only hits `terrain-gen-controls.js:45`/`:86`, mapspinner demo panel writing and rereading it.
- Two latent inversions: `halfResWater` declared `false` but read `!== false` (`gl-render.js:1444,1555`), so unset means ON — reconciled only by `QualityPresets.js:95` setting it. `dprAuto` declared `true` while every preset sets it `false`, so registry default never applies in a real run.
- AMD frame-time verdict needs a quiet window (`gpulock` = ADAPTER only, never CPU). Slow AMD capture = shared-box signature: one page read 392.76 ms p50 at 720p, 59.97 at 64x64, 13.10 back at 720p on identical draw calls, vs quiet-window 22.55-24.08 ms. Settle probe under 40 frames per 2000 ms = "box busy"; `scripts/lib/host-contention.mjs` cannot see it — contention is GPU-side.
- Contention gate needs a GPU-bound control page: refuses on no cadence, floor unreached, quantum at 1.5x own p50, or before/after >1.25x; no capture writes a slower baseline (`--accept-slower=<reason>`).
- Decide perf rows on counted work units: an ms-per-tick counter is not a measurement, never-incremented counter a silent pass — confirm field exists on measured backend (`vegProfile.meshInstances` absent on `WebGPULodInstancer`). Authoritative draw count = `perf-run.mjs drawsInstrument.authoritativeField`. WebGPU `info.render.calls` CUMULATIVE, only reliable liveness signal (`drawCalls`/`.triangles` read 0).
- WebGPU TSL-vs-legacy parity written BEFORE any frame: region matches iff cross-renderer meanAbs/channel <= 3 x max(same-renderer noise floor, `QUANT_FLOOR`). Establish same-code floor first: same code vs itself = 0.470 meanAbs / 86.72% exact vs post-change 0.467 / 87.46%, so 13% of pixels differing is not drift.
- `prediction-drift-witness.mjs` diagnostic for "client led server": caps peak unacked 24, divergence 3 m, last 5 samples under `--settle-tol` 0.5 m; `--server-tick=<hz>` only lever. At `--server-tick=10` floor is one 100 ms step, so it needs raised caps.
- CDP `Input.dispatchKeyEvent` reaches app input bucket — read `window.__app.sentInput`/`sentInputCount`. Keyboard sets `input.backward`, never `input.back`. `[physics] peak active 0` does not mean a stalled player: `CharacterVirtual` never counted by `GetNumActiveBodies()`.
- Witness with a fixed scratch dir must `rm` it at start: a gate run killed at its 120 s cap leaves it behind and later runs hang on it (`terrain-reseed-failure-witness.mjs`).
- gm `exec_js` dispatches ephemeral: a server booted in one is gone by the next. Use `127.0.0.1`, not `localhost`.
- Headless Node witness constructing `PhysicsNetworkClient` must polyfill `globalThis.WebSocket` from `ws`.
- `edge-collider-draco-witness.mjs` rewrites tracked `apps/tps-game/*.glb` in place — never run inside a gate.

## Security

- Re-run dependency scan on any fresh or updated `node_modules`.
- `SESCompartmentEvaluator.js` only untrusted-app evaluator, fails closed; `StaticHandler` enforces path containment + COEP `require-corp`. Failed `import('ses')`/lockdown throws `SandboxUnavailableError`.
- `authCompare.js timingSafeTokenEqual` self-compares (`bufA,bufA`) on a length mismatch so token length is not leaked — do not simplify away.
- Benign exec surfaces, never flag as malware: `lang/spoint.js`, `mapspinner/planet.html`, `scaffold.js`, `cdp-browser.mjs`.

@.gm/next-step.md
