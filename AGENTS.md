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

- Commit as lanmower, main-only, `git_commit` explicit `paths`; pathless `git_finalize` sweeps another lane's edit. Push `git_push {rev:"HEAD"}`; bare `git_push {branch:...}` is gate-denied.
- `.git/index.lock` present fails `git_commit`; foreign stalled git holds it 20+ min — confirm via `Get-CimInstance Win32_Process`; 0-byte lock + no spoint git alive = removable.
- Generated artifacts ship with source: `AppContext.js` -> `sdk-typings.generated.d.ts`; height-code change re-bakes `apps/world/*.hf`.
- `check-cache-keys.mjs` shared: editing another transform's `BAKE_INPUTS_*` reddens `npm run check` every lane till the `cacheCodeVersions.js` pin bumps in the same commit. `check.mjs` parses TRACKED files only. A `BAKE_TRANSFORMS` entry (`BakeCodeVersion.js`) names the narrowest module the transform reads, NOT its import closure.
- `core.autocrlf=true`; `w/crlf` in `git ls-files --eol` = no diff. `git_diff` ignores autocrlf: disk/blob ending mismatch reads as whole-file rewrite.
- `.gitignore` re-includes `.gm/*` only under `.gm/memories/` + `.gm/disciplines/project/`; other `.gm/` paths uncommittable silently.
- Untracking: gm `git_rm {"cached":true}` + paths-scoped `git_commit` (`index_commit:true`) with byte-identical `git ls-files` paths; any other spelling re-adds.
- gm MCP = HTTP, not stdio (`http://127.0.0.1:8787/mcp`); Claude Code connects once, never retries; startup gap detaches session — recover via `/mcp`.
- `@spoint/ecs` resolves only via `@spoint/*`; link vanishes mid-session, kills every harness — `npm run links` restores, never `npm install`.
- `scripts/gpulock.mjs run <owner> -- <node> <script>` serializes accelerated arms via `.gpu-lock/owner.json`. ADAPTER only, never CPU; returns 0 even when the witness failed, so grep the run's log for `RESULT:`.
- Never `git worktree remove` a `scripts/worktree-setup.mjs` worktree (node_modules junction deletes `node_modules/.bin`); use `scripts/worktree-teardown.mjs`.
- gm spool: `in/<verb>/<session_id>-<random8>.txt`; write a sibling `.tmp` and RENAME onto `.txt` (straight write dispatches a torn body).
- CI: completing jobs = `check` + `frame-time-coverage`; `frame-time` carries `if: vars.CI_GPU_RUNNER_ONLINE == 'true'`, so no runner + var unset = SKIPPED. `concurrency` group is PER SHA; CI Node 20 vs box Node 24.
- `npm run check` (gpu-free arm -> `fire-witness-gate.mjs` -> `check-frame-time-baselines` -> `SPOINT_GPU_WITNESS`) parses only tracked `src,client,apps,scripts,bin`, refuses browser/GPU witnesses by name; witness must exit 0 AND print `RESULT: PASS`.
- Gpu-free admission is by capability, not cost: a witness belongs iff it needs no browser + no GPU context.

## Repo boundaries

- `design` ships as pinned CDN URLs in `client/{index,landing/index,editor/thebird-host}.html` + `scripts/bundle-client.mjs`. `vendor/*` editing-only submodules.
- `apps/*` never imports `client/*` (singleplayer Worker resolves relative specifiers vs virtual root); expose utilities on `engineCtx`.
- Keep Node-only dynamic import specifiers opaque to esbuild/wrangler: build in IIFE, `(() => './' + 'ServerAPI' + '.js')()`. `edge/cf-do/spoint-do.js` imports `jolt-edge-init.js` BEFORE `WorkerEntry.js`.

## Debugging discipline

- Bug surviving threshold change = not fixed; re-diagnose. Fixing failure end-to-end at its own layer = second copy of same check (`ShapeBuilder.js`, `cluster-lod-mesh.js`).
- **Silent-no-op class**: a knob with no consumer, or whose enable bit defaults off, reads as a working lever, so measuring through it measures nothing: `?noveg`, VDRS `__vdrsScale`, `?legacygl=1`, `u.fsCheap`, `perf-run.mjs inputReachedGame`, `perf-run.mjs --no-walk` (a static arm reported ctx0 p50 0.1311 ms against a 33.22 ms wall frame with matching CPU, ~95% of samples read ~0.13 ms while the GPU was busy; use walking arms for GPU timing). Before trusting a knob, codesearch its reader and check its enable bit.
- libuv `uv_async_send` assert: fires at `process.exit()` with handles mid-close; headless scripts await `process._getActiveHandles()` hitting 0.
- Witness needing server to act on a client message passes `--params=multiplayer`; `?singleplayer` sees `players:0`, acks `ok:false`. Harness returning uncompared `{expected, got}` passes either way: one `expect()` per measurement, non-zero exit.
- One `gl.getError()` code covers distinct bugs (1282 = feedback-loop, sampler-type-mismatch AND insufficient-buffer-size): read the driver's own console string off a cache-disabled reload.
- Live GL: all `window`/`document` access through `page.evaluate()` in a capture-prefixed script; pin file:line via `addInitScript` wrapping `drawElementsInstanced` to drain-then-check `gl.getError()`; editor via `app.clientMachine.send('TOGGLE_EDITOR')`.
- Troubleshooting (`scripts/lib/`): `head-vs-worktree.mjs <paths>`, `gm-dispatch.mjs <verb> [body]` when MCP detached, `witness-audit.mjs`.
- `witness-audit.mjs --gate` = gpu-free arm of `npm run check`: per-file per-check counts vs committed `.witness-audit-baseline.json`; fails on absent check id or count above it.

## Entry points

- `ctx.defineGameFSM(spec)` `src/behaviours/game-fsm.js`; `ClientMachine.js` xstate5 parallel, fallback `after:` 10 s gated / 45 s hard stop.
- `ctx.defineFire(spec)` `src/behaviours/fire.js` (wired at `src/apps/AppContext.js:387`, default off).
- Test relocation: `window.__spoint` + `MSG.TELEPORT` (0xc2 / ACK 0xc3, `src/sdk/Relocation.js`; no `EDITOR_TOKEN` = any client, `relocation:false` disables, >87 deg refuses). `window.__spoint._drive` = `Relocation.js drive()`, wrap it to OBSERVE input.
- Client app's `ctx.state` = entity `custom` block (`AppModuleSystem.js`), not server app state: `ctx.state.<key> ?? literal` takes the literal forever. `engine.cam` = camera CONTROLLER, no `position` — read `engine.client.getLocalState().position`.
- Wireweave attach helpers run after awaits (host migration reassigns `client` in `app.js`): re-check at call time.
- `createServer()` per-call factory; `boot()` SIGINT/SIGTERM handlers process-global: stop with `RoomDirectory.stopAll`.
- Remote server's `netcode.profile` named only when client = real `PhysicsNetworkClient`: boot that witness on `?connect=...&multiplayer=1`, else falls back to in-page `BrowserServer`.

## Fire

- Integer-only kernel `fireKernel.js`: decisions from `hash(seed, step, face, I, J)`, no float / `Math.random` / `Date.now`.
- Rain smothers, does not eat fuel: a rain-suppressed cell still burns `burnRate`, pushes no heat, spots nothing (`fireKernel.js burnCell`). `rainPerIntensity` (255, `fireSpec.js`) maps intensity 0..1 to a roll byte.
- `ctx.navCostAt(x,z)` = 8 burning / 2 charred; `canSee` smoke-gated via `_fireNavByRuntime` at depth >= `smokeBlockDepth`.
- Wind = weather vector (BASE) + `hash(seed, step)` gust, clamped +-16 per axis; `snapshot().wind` carries BASE only.
- Per-cell initial fuel not recomputable in kernel (`classify()`, `VegPlacement.js`); a per-tile array added to `snapshot()`/`restore()` joins `TILE_ARRAYS` (`fireKeyframe.js`) + VERSION bump (now 6).
- Tampered keyframe rejected at DECODE, named `[fireKeyframe]` error. `G` = ignition step mod 256, not age; IGNITE_AREA kind 5.
- Boundary snapshot's `delta` rolls back the step BEFORE it (`takeDelta` at t=K reads `preStep` captured at K-`stepTicks`); restore verifies against the boundary's `counters`, never its `delta`. `adopt`/`rewindTo`/`submit` return `{ok, reason, detail}`.

## Planet-wide multiplayer

- One server world per cluster, each own flat chart. Jolt heap fixed `JOLT_WASM_HEAP_BYTES` 134217728 B (`src/shared/clusterConfig.js:8`), never grows; over it `new J.JoltInterface` raises `Aborted(OOM)`.
- Three limits, not one cap: `maxContactConstraints` under requirement drops contacts silently; `maxBodies` under population makes Jolt return body id 0, so overflow bodies share one map key and `destroy()` aborts wasm.
- Assignment pure, hysteretic, antipodal-safe, 2-4 Hz; `resolveClusterConfig` refuses a link below the relevance ring or longest weapon range.
- Collider rings (`ColliderStreamer.js`): `DEFAULT_MAX_CENTERS = 192` for BOTH trunk + rock streamers; rings per connected player, never centroid. `classifyRings` per-cluster quota resets every pass, first-fill, no guarantee; `evictOverCap` farthest-first.
- `planetRadius` is 0 in EVERY shipped world: `src/stage/Stage.js:8` sets `spatial.planetRadius = config.planetRadius || 0` and no world def assigns it, so `TickHandler.js:230` is always 0 and the cube-sphere branches (`resolvePlayerCell`, `solveCellViewer`, `computeRingRelevantIds`) never execute — only the flat ring path is live or covered.

## Chart re-anchor

- Chart-local server holders migrate via `src/sdk/chartState/` (`attachServerChartMigrators(ctx, service)`, default off). Re-anchor = change of basis, not rotation: position/velocity/forward invariant. CHART_REANCHOR = 0xc6.
- Flat chart's intrinsic tilt fixed by shrinking the chart: `CHART_ANCHORS_PER_FACE = 32`. `CHART_REANCHOR_ANGLE_DEG` (28 / 14) must exceed the worst angle of its `createChartAnchorLattice` or the anchor thrashes.
- Exactly ONE chart per world; two players at separation Delta sit at Delta/2, walkable iff `terrainTilt + Delta/2 <= 45 deg`.

## Physics and Jolt

- `physics.setBodyMotionType` returns a NEW body id or `false`; a body created Static cannot be made to simulate by `SetMotionType` at all, hence recreation. `IsActive()` is the only discriminator — `GetMotionProperties()` is non-null even on a static-created body.
- Recreation creates the new body BEFORE destroying the old, on `LAYER_DYNAMIC`, refusing a body holding a constraint, vehicle chassis or trimesh/mesh/heightfield shape.
- A pooled body whose `bodyMeta.type` != requested motionType is destroyed + replaced (`scaledShapeKey()` encodes model|scale only); a matching slot revives via `_revivePooledBody`; `removeBody` on pooled DYNAMIC does `DeactivateBody` + zeroes both velocities.
- `BodyInterface.GetPosition` returns ONE shared temp, so two calls alias — `addConstraint` reads default anchors via `getBodyPosition`. Jolt recycles removed bodies' tree nodes only in `physics.step`: re-adding thousands of bodies with no step between aborts wasm.
- Jolt `HeightFieldShape` exposes `GetMinHeightValue()`/`GetMaxHeightValue()`/`GetSampleCount()`, NOT `get_mMinHeightValue`; `GetSampleCount()` = PER-SIDE count (N), not N*N.
- Trimesh/convex collider build failure in `src/apps/AppPhysics.js` PROPAGATES as `ColliderBuildError`, never degrades to a 0.5 m box; `AppRuntime` `config.autoTrimesh` branch + `EditorHandlers.js` still box.
- `AppRuntimePhysics.js` skips `e._vehicleId != null` in BOTH `_tickPhysicsLOD` + `_enforceBodyBudget`. Height samples snap to 1 mm via deliberate `+ 0`: `Math.round` of a sample in (-0.5 mm, 0) yields -0; -0/+0 differ as `Float32Array` bits.
- `VehiclePhysics.js`: never `J.destroy` `v.constraint`/`v.tester` after `RemoveConstraint`, never destroy `get_mTracks()` copies after `set_mTracks`; empty `mDifferentials` = zero wheel torque.
- EDITOR_UPDATE calls `syncEntityCollider` AFTER `changeBodyType` (which removes the body and clobbers `custom._collider`).

## Terrain and colliders

- `solveSurfaceY` tolerance absolute `1e-4` (`SURFACE_SOLVE_TOLERANCE_M`, `PlanetFrame.js`), 64-eval cap, throws `SurfaceSolveError`; past 63.6 km returns `-(R+anchorHeight)`, NO throw.
- Baked heightfield FAIL-LOUD (`src/terrain/TerrainPhysics.js`): absent = silent CPU fallback; unreadable/truncated/bad-magic/stale-code throw a named `[baked-heightfield]` error. A `hashVersion`/`terrainKey`/`chartEpoch` mismatch warns + falls back.
- No terrain FATAL: `ServerAPI.loadWorld` rethrows `[terrain] world "<id>" has no terrain`; every caller stops the server it created first.
- Two height backends; v2 = parity backend, carves (`terrainCarvesOf`) v2-only. v2 is mean 0.001/max 0.005 m vs v1 mean 1.288/max 2.840 m.
- `elevationAtLocal(frame,x,y,z)` is exactly `|p|-radius`; app-facing `ctx.terrainHeightAt` is NOT that.
- `PlanetFrame.groundHeightLocal` caches in 4096 direct-mapped slots keyed by EXACT `(x,z)` + chartEpoch (memoising `SurfaceSolveError` too).
- `terrain.glsl` `snoise3`/`vnoise2`/`seaHash`/`hpfSample` take the in-cell fraction as `P-floor(P)` from ONE `floor`.
- Server terrain collider lives in ONE fixed-anchor local tangent plane (`createPlanetFrame`, `anchorDir` default [0,1,0], never re-anchored): cannot represent directions past ~87 deg from the anchor.
- `gl-render.js sampleGroundM` is fire-and-forget async (PBO+fence): each call returns the PREVIOUS call's harvested height; non-rAF callers use `sampleGroundMSync`, which poisons the next async collision read.
- `VegPlacement.js`/`RockPlacement.js` read climate before `surfaceOfCell` only when `climateUsesLocalXZ !== true`. Veg density must gate on painted snow, else surviving grass weight roots trees.
- Snow resamples only after >0.1 m drift (`SNOW_GROUND_RESAMPLE_DRIFT_M`, `Weather.js`): 229 -> 46 samples/update.
- REFUTED, do not retry blind: 2-tap forward difference in `src/terrain/PlacementChart.js radialSlopeAt` — the gradient crosses `SLOPE_MAX` 0.6, flipping gate decisions.

## Netcode and wire

- Prediction suppresses only the blocked DIRECTION: `_reconcile` (`PredictionEngine.js`) derives `wedgeNormal` in `_updateServerBlock` from commanded-vs-achieved motion, else `-velocity` when stopped while commanding; `shared/characterStep.js` projects out that component alone.
- Client peer separation is a win (`CollisionSystem.js applyPlayerCollisions` pushes overlap/2 per tick): 0.1943/0.2049 corrections per ack vs 0.7422.
- `msgpack.js` `WIRE_STRUCTURES[1]` lists exactly the keys, in order, of `TickHandler.js _packPayload` (seq,tick,serverTime,players,entities,removed,delta,dots). msgpackr 2.0.4 writes -0 as `0x00`; `patch-deps.mjs` excludes -0 from both integer tests. Raw ws clients must mirror `COALESCE_SENTINEL`/`splitCoalesced`: `0xFF` then `[uint32 LE length][msgpack]`.
- Wire v3 player record: 8 fields in a 22-byte bin; `[inputSequence, inputBuffer, groundNormal]` ride a per-recipient `me` block, so snapshots pack per recipient. `getSnapshot()` keys on `_version === _snapshotVersion` alone.
- `PhysicsNetworkClient.connect()` REJECTS, named `TransportConnectError` (`err.reason`: `websocket-unavailable`|`websocket-error`|`websocket-closed-before-open`|`connect-superseded`), not `connected:false` + no socket; retry belongs in the caller (`_doReconnect`), never in fake success.
- `SnapshotGroupPlanner`: groups = `ceil(viewers*perViewerMs/(budgetMs-fixedMs))`, budget = tick period * `SNAP_COST_HIGH_FRAC` 0.35 (`TickHandler.js:30`). Interest management off by default: `getRelevanceRadius` returns `relevanceRadius || 0` and no world sets it, so `playersInInterest` returns every player.
- Lockstep: rollback is input-capped, so measure by depth, not rate (`maxRollbackTicks` 12); `inputDelayTicks` above `INPUT_RETAIN_TICKS` (240) throws at construction.
- A socket becomes a player by MIGRATE, RECONNECT, or silence past the MIGRATE-peek grace (`ServerHandlers.js onClientConnect`, 50 / 1500 ms dilated) — a silent probe joins as a phantom, so probes use `?probe=1`. Never answer an unresolvable RECONNECT with INVALID_SESSION and leave it open: `rejectSession` flushes + closes.
- Migration keeps the old transport as fallback owner, hands the player back on candidate death; a close from a transport client no longer owning cannot tear it down.
- Authoritative path: prediction off by default (`?predict` only); rollback/lockstep unwired. `TickHandler.js processPlayerMovement` takes ONE input per tick, catching up only while `inputs.length > INPUT_BUFFER_CATCHUP_DEPTH` 8, `extra < MAX_CATCHUP_STEPS_PER_TICK` 3, `player.inputStepBudget >= 1`.
- `BaseClient.js sendInput` stops feeding `predEngine.addInput` once `predictionLeadSteps()` reaches `MAX_PREDICTION_LEAD_STEPS` 16; a fast client degrades to bounded lead.

## Rendering

- `WebGPURenderer` DEFAULT (`?legacygl=1` opts out); unavailable WebGPU retries `forceWebGL=true` before legacy, so TSL is the only shader path. WebGPU uses TerrainBackdrop's `fE` as a per-vertex clip transform; WebGL uses it only for CPU frustum culling.
- `three.webgpu.js` drops pending `popErrorScope()` rejections at 3 sites; `patch-deps.mjs` patches all three. `ClusterLodMesh._render` fires once PER GROUP per frame: keep the `_lastRenderFrame===frame` early-return. `webgpu-hiz-shaders.js` HiZ compute cull must equal the CPU cull: divergence silently culls the wrong cells.
- Veg LOD: `WebGPULodInstancer` oracle mirrors `updateLOD` — `lodEye` refreshes only after 0.5 m (`LOD_REEVAL_MOVE_SQ`). A leaf instancer is a SATELLITE of its branch (`opts.host`): no own grid, `updateLOD` returns immediately, tier/shadow/visibility mirrored.
- Every discard in the `terrain.glsl` FS stays inside `#ifdef _WATERPASS_` (a discard anywhere disables early-Z depth write for all its draws). It is the SoT for CPU/GPU height parity (`gen-height.mjs` transpiles it); deleting it needs a new SoT + TSL/WGSL->JS generator.
- Default-path terrain FS is TSL, NOT `terrain.glsl`: `TerrainBackdrop.js:43` imports `mapspinner/src/tsl/planet-tsl.js` when `isWebGPU`. `terrain.glsl` = legacy `?legacygl=1` path + height-parity SoT, so its `_WATERPASS_` rule governs the GLSL body only.
- Counted per pixel on the live TSL path: LAND = 9 `snoise3` (~900 ALU) + 19-31 fetches, 12-24 triplanar from a 1024^2 4-layer RGBA8 mip set at `anisotropy = 8` (~43 MB, past an iGPU cache). WATER = 77-107 `seaOctave` (~5-7k ALU) = 5-7x terrain/px + a full-screen copy — yet measured ~0 because terrain occludes it. VS = 240 `snoise3`/vertex (`composeHeight` 48 x `FD_TAPS` 5).
- `terrain-lighting-tsl.js` leaves `sky.marchRadiance` ungated where GLSL gates it (`terrain.glsl:972`); `mix(lit, hazed, 0) === lit`, so gating is bit-identical. Terrain draws LAST among opaques (`TERRAIN_DRAWS_AFTER_OPAQUE_OCCLUDERS` = 10) so early-Z never rejects it; water is `WATER_DRAWS_BEFORE_OTHER_TRANSPARENTS` = -1, so its shading is always paid. `texFarFade > 0.001` (`surface-splat-tsl.js:133`) buys 12-24 fetches for a 0.001 contribution.
- TSL `select` outside `uniformFlow` emits real `if/else`, not a ternary (three's `ConditionalNode`) — both sides are NOT evaluated.
- Reduced-resolution terrain (VDRS) has NO consumer on the live path: `packages/mapspinner/src/tsl` has zero `vdrs`, and `TerrainBackdrop.js:36` `isTslTerrain = isWebGPU` makes the `else if (isWebGPU)` branch unreachable. Consumers read `__vdrsScale` ONLY when `window.__vdrs === true` (default false), so its null result set the scale without the enable bit.
- `?legacygl=1` is silently dropped unless in-page server (`app.js:191`): it needs `?singleplayer&legacygl=1` and flips terrain hashVersion, so a legacy run is NOT comparable to a TSL number. `u.fsCheap` swaps only `outputNode`, not `colorNode`, so it is not a valid FS probe. Terrain is `side = DoubleSide` (`terrain-material-tsl.js:198`): no backface culling.
- Dead per-pixel taps: `octFarFade` saturates to 1.0 beyond ~15 m, so `mix(albNear, albFar, 1.0) === albFar` — 6 fetches/layer computed and multiplied by zero, up to 12 with the second layer (`texFar1 = 10000` keeps it enabled to ~10 km). `bandWarp`'s 2 `snoise3` (`surface-splat-tsl.js`) also sit OUTSIDE the `texFarFade` gate. Deleting both is byte-identical.
- Legacy-vs-TSL: `terrain.glsl` mixes the raw interpolated vertex normal while TSL normalizes first; `reliefShade` 6 amplifies 0.53/0.73 into a 3.11/5.67 delta.
- `invertAcesFilmic` must NOT end in `max(x, 0)`: saturated blue inverts to (-0.034,0.346,1.395), out of AP1/ACES gamut; clamping re-encodes 82.7 vs 55.9. Rendered sea = sphere R == `PlanetFrame.waterlineLocalY` to 1 cm + ZERO-MEAN waves (`swellP` heaved +-0.40 m, mean +0.254).
- `ShadowPipeline.js forceUpdate` sets EVERY cascade `light.shadow.needsUpdate`; `cascadeCount` clamps to 1 when `sun.castShadow===false` (cascade 0 IS the sun, never renders). `QualityPresets.js` ships `ssao`/`bloom` false on EVERY preset.
- Vegetation `InstancedMesh2`: `sortObjects` stays false with LODs; `CullFreeze.js setInstancedCullAuto` sets `autoUpdate` on the parent AND every LOD level. `model-pool.js` drains allow >=1 unit/frame or a zero budget deadlocks.
- Wall-clock budget buys WAITING, not work: Veg+Rocks `prewarm` budget WORK sliced 24 ms on macrotask yield, but `Grass.prewarm` budgets WALL-CLOCK, rAF-yielding every 8 chunks, so waits charge against `PLAYABLE_BUDGET_MS`.

## Client and app runtime

- HUD `applyDiff(uiRoot, hudVdom)` replaces uiRoot children every frame; imperative DOM overlays mount on `document.body`.
- `_buildWorldScenery` joinable wrapper; boot adopts a running build (`Promise.race` does not cancel the loser).
- `app.js animate()` returns early while `window.__warmupInFlight`; model-pool + streaming loads pump from frame jobs there, so never park a wait inside warmup.
- Client `WORLD_DEF` from `sendWorldDefAndModules` has `entities` STRIPPED, carries `_modelUrls`: derive world-entity facts from `_modelUrls`.
- Hot reload releases ctx via `AppRuntime._releaseAppContext`; `update()` keeps running with a torn-down ctx unless `_updateList`/`_rebuildCollisionList` are rebuilt.
- `AppRuntime._attachApp` does `apps.set` BEFORE awaiting `setup()`; `spawnEntity` attaches apps fire-and-forget, so collect tagged entities on the first `update()` tick.
- Spawn: `holdSpawnUntilGrounded` (`src/sdk/Relocation.js`) gates release on `terrainFieldMissingAt`/`coversPosition` (max `SPAWN_HOLD_MAX_MS=20000`).
- Respawn clearance shared: `src/apps/AppGameplay.js pickSpawnPoint` + tps-game use one `footprintBlockers` sampler (17 down-ray columns; surface > `MAX_FOOTPRINT_INTRUSION_M` 0.15 m above the column bottom = `intruding`).
- `BrowserServer.js`: `_lastTodSync` + `_deliveredWorldFingerprints` are MODULE level — stall recovery + HostMigration rebuild a fresh BrowserServer in the same page.
- Singleplayer worker world identity from `INIT.worldName`; snapshot = one IDB key `world-snapshot` per origin.
- `FloatingOrigin.js update()` does `camera.position.set(0,0,0)` on rebase, not `+= -delta`.

## Measurement and witnessing

- Every named GPU arm pins its adapter: `vendorGpuArgs(vendor)` adds `--use-adapter-luid=0,<luid>`; `gpu-probe.mjs gpuLaunchArgs()` does NOT. Pinning is necessary, NOT sufficient — Chrome ignores an unresolvable LUID while reporting accelerated, so assert the renderer string (`assertGpu`/`witnessGpu`). AMD LUID is per-boot.
- REFUTED: the AMD iGPU does not lose GPU context at boot; the hang was `probeGpu()` minting a fresh WebGL2 context in the page measured, so `probeGpu` now reads `window.__rendererInfo`. Never mint a context in a page you measure.
- A software rasterizer cannot reach the gate floor, so the frame-time arm needs an accelerated runner. A vsync-locked p50 is a refresh divisor, not work; `frame-time-gate.mjs` unlocks rAF. Baselines are PER-VENDOR (another adapter's is refused; an unbaselined vendor fails loudly): AMD 18.39 ms `ee756369`, NVIDIA 9.03 ms `76059b48`.
- The AMD iGPU DOES expose `timestamp-query`, so `--gpu-passes --extra=gputime=1 --backend=webgpu` works (`npm run build:client` first or FATAL): 1080p GPU p50 25.36 ms vs 15.88 ms CPU = GPU-bound; NVIDIA 5.18 ms, vsync-locked, NOT GPU-bound. Per-pass `avgMs` is DRAIN-BIASED 25-36% low — quote `p50Ms`, never avg — re-derive every pre-`52b09a09` per-pass average.
- The per-stage split IS delivered (`?gpuhide=`/`?gpuab=`, `52b09a09`). AMD 1080p p50: sky 1.38, trees 0.33, grass 0.33, rocks 0.10, residual 1.90, water ~0; ctx2 shadow 0.131, ctx1 composite 0.393. A resolution sweep (triangles within 0.5%) fits ctx0 = 6.607 + 8.665·Mpx, R² 0.9904: 4.00x fewer pixels moves ctx0 13.11 ms, so the scaling part is fragment work — but 6.61 ms (26.7%) does not scale.
- `?gpuhide=terrain,water` puts that whole fixed floor in terrain: terrain = 6.27 + 4.34·Mpx vs a 1.03 + 4.09·Mpx rest, i.e. 9.00 ms fragment + 6.27 ms fixed at 1080p. The floor is UNEXPLAINED, not vertex work: cutting terrain geometry ~80% (`__maxLevel` 11 -> 2, ~41k -> ~8k vertices) moved ctx0 +0.26/+0.45 ms, ~0.2x noise where ~4x was predicted, while CPU frame wall halved 33.07 -> 16.70 ms. So reduced-res terrain reaches only the pixel half (capped ~9.00 ms, NOT ~70% of ctx0), and ctx0 < 16 ms needs ~8.8 ms, i.e. the pixel half AND the floor. Vegetation sits inside noise (~130k triangles move ctx0 0.33 ms); post is the 0.39 ms blit with `ssao`/`bloom`/`ssr` all false.
- Planet + foliage toggles: `?lightplanet` stubs the planet but keeps the height sampler + all foliage; `?veg=none`/`?nograss`/`?norocks` are real; **`?noveg` is NOT a flag** — it silently no-ops. `window.__vegAllOff` kills foliage per frame. No app-level per-part toggle: `perf-run.mjs` supplies `?gpuhide=terrain,water,sky` + `?gpuab=<windowGlobal>` (boolean only: `window[abName] = abOn`); `?gpuabms=` does not move the phase (5000 at 99999999). So a numeric knob is unreachable from the harness: `window.__renderControls.set('maxLevel', N)` needs a code change, and `?gpuab=__maxLevel` sets `true`/`false`, which `Math.max(2, Math.min(22, x|0))` clamps to 2. AMD noise is +-1.3 ms planet-ON, +-0.2 ms planet-OFF, so sub-2 ms stages need in-run A/B.
- NVIDIA: planet = 8.6 of 11.0 ctx0 (78%), the same 78% as AMD, so the RATIO holds — but NVIDIA ABSOLUTE ms are NOT comparable across sessions (a 2.3x shift vs its own 5.18 ms control, cause unfound). Its per-arm split does not close additively (terrain+sky 9.9 > planet 8.6). AMD absolute ctx0 is SESSION-LOCAL: 15.93 vs 24.77 ms at 1080p across sessions (travel 484.9 vs 225.8 m; adaptive fog pull-in plausible) — compare within a session.
- Unresolved: vegetation costs 0.33 ms planet-on but 3.21 ms planet-off, same triangles — never quote one cost without the planet state.
- An AMD frame-time verdict needs a quiet window (`gpulock` = ADAPTER only, never CPU). A slow AMD capture is a shared-box signature: one page read 392.76 ms p50 at 720p, 59.97 at 64x64 and 13.10 back at 720p on identical draw calls, vs a quiet-window 22.55-24.08 ms. A settle probe under 40 frames per 2000 ms = "box busy"; `scripts/lib/host-contention.mjs` cannot see it — the contention is GPU-side. Two `splitFactor` A/B arms read 21.95-38.60 ms and were discarded — another lane held the GPU.
- The contention gate needs a GPU-bound control page: it refuses on no cadence, a floor unreached, a quantum at 1.5x own p50, or before/after >1.25x; no capture writes a slower baseline (`--accept-slower=<reason>`).
- Decide perf rows on counted work units: an ms-per-tick counter is not a measurement and a never-incremented counter is a silent pass — confirm the field exists on the measured backend (`vegProfile.meshInstances` is absent on `WebGPULodInstancer`). Authoritative draw count = `perf-run.mjs drawsInstrument.authoritativeField`. WebGPU `info.render.calls` is CUMULATIVE, the only reliable liveness signal (`drawCalls`/`.triangles` read 0).
- WebGPU TSL-vs-legacy parity is written BEFORE any frame: a region matches iff cross-renderer meanAbs/channel <= 3 x max(same-renderer noise floor, `QUANT_FLOOR`).
- `prediction-drift-witness.mjs` is the diagnostic for "client led server": caps peak unacked (24), peak divergence (3 m) and the last 5 samples under `--settle-tol` (0.5 m); `--server-tick=<hz>` is the only lever. At `--server-tick=10` the floor is one 100 ms step, so it needs raised caps.
- CDP `Input.dispatchKeyEvent` reaches the app input bucket — read `window.__app.sentInput`/`sentInputCount`. Keyboard sets `input.backward`, never `input.back`. `[physics] peak active 0` does not mean a stalled player: `CharacterVirtual` is never counted by `GetNumActiveBodies()`.
- A witness with a fixed scratch dir must `rm` it at start: a gate run killed at its 120 s cap leaves it behind and later runs hang on it (`terrain-reseed-failure-witness.mjs`, `956b91e2`).
- gm `exec_js` dispatches are ephemeral: a server booted in one is gone by the next. Use `127.0.0.1`, not `localhost`.
- A headless Node witness constructing `PhysicsNetworkClient` must polyfill `globalThis.WebSocket` from `ws` — Node 20 has none, so every multiplayer arm fails "only 0 of 2 client(s) joined".
- `edge-collider-draco-witness.mjs` rewrites tracked `apps/tps-game/*.glb` in place — never run inside a gate.

## Security

- Re-run the dependency scan on any fresh or updated `node_modules` (the HiddenSpawn second-stage loader is already cleaned).
- `SESCompartmentEvaluator.js` is the only untrusted-app evaluator, fails closed, no proxy tier; `StaticHandler` enforces path containment + COEP `require-corp`. A failed `import('ses')`/lockdown throws `SandboxUnavailableError` (SANDBOX_UNAVAILABLE).
- `authCompare.js timingSafeTokenEqual` self-compares (`bufA,bufA`) on a length mismatch so token length is not leaked — do not simplify away.
- Benign exec surfaces, never flag as malware: `lang/spoint.js`, `mapspinner/planet.html`, `scaffold.js`, `cdp-browser.mjs`.

@.gm/next-step.md
