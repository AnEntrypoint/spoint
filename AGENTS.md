# AGENTS.md

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

Fewest words per fact. Deep detail: `project/*` recall memos.

## Working rules

- Main-only branch; commit only as lanmower (`git_commit` with explicit `paths`, never `git add` + bare commit, `0292ad7b`). AI co-author trailers are a one-way door (`auto-declaudeify.yml`).
- Generated artifacts travel with source: `src/apps/AppContext.js` -> `gen-typings`' `client/editor/sdk-typings.generated.d.ts`; a height-code change re-bakes `apps/world/*.hf`.
- `core.autocrlf=true`: tree CRLF, index LF; `w/crlf` in `git ls-files --eol` is not a diff. Green locally + red in CI on untouched files is line-ending or path case.
- `@spoint/ecs` is the only `@spoint/*` specifier; its link vanishes mid-session and kills every harness. `npm run links` restores it; never `npm install`.
- `gpulock.mjs run <owner> bash ...` exits 127; pass the node binary and a .mjs script. It returns 0 even when the witness failed: grep the log for `RESULT:`.
- Never `git worktree remove` a worktree from `scripts/worktree-setup.mjs` (its node_modules junction makes git delete main `node_modules/.bin`); use `node scripts/worktree-teardown.mjs <path>`.
- gm spool files must be named `in/<verb>/<session_id>-<random8>.txt`. codesearch sees the WORKING tree, so another lane's edit can hide a committed constant.
- Comment sweep: gm `grep` `{"mode":"comments","refresh":true}`; `exhaustive:false` = 200-match cap; `glob` matches FILENAMES.
- Ship an opportunity noticed while working in the same pass (before/after witness) or `prd-add` it. Unmeasured speedup claims never ship.

## Repo boundaries

- `design` ships as pinned CDN URLs in the importmaps of `client/index.html`, `client/landing/index.html`, `client/editor/thebird-host.html`, `scripts/bundle-client.mjs` (`anentrypoint-design` -> unpkg `1.0.34/dist/247420.{js,css}`.
- `vendor/*` are editing-only submodules: edit on their own `main`, push, then commit the gitlink. Every UI component is built in `AnEntrypoint/design` (`src/components/game-editor-kit/`).
- `scripts/bundle-client.mjs` output stays `dist/client/app.js`, unhashed.
- `apps/*` must never import `client/*` (the singleplayer Worker resolves relative specifiers against a virtual root); expose utilities on `engineCtx` (`engine.createEmoteWheel`, `engine.THREE`, `ctx.kit`).
- `apps-manifest.json` is gitignored and derived: `client/BrowserServer.js:108` resolves it against the client root, `src/sdk/ServerBoot.js:82` reads `dist/client/apps-manifest.json`; postinstall generates it.
- Keep Node-only dynamic import specifiers opaque to esbuild/wrangler by building them inside an IIFE — `(() => './' + 'ServerAPI' + '.js')()` (`EditorHandlers.js _serverApiPath`, `src/physics/DracoDecompressor.js`, `World.js getJolt`).
- `globalThis.__SPOINT_EDGE_BUNDLED__` is set at `jolt-edge-init.js` top level, so `edge/cf-do/spoint-do.js` must import `jolt-edge-init.js` BEFORE `WorkerEntry.js`.
- Module Workers do not inherit the document importmap, so `client/workers/OffscreenRenderWorker.js` imports three via `/node_modules/three/build/three.module.js`, not bare `three`.
- `src/sdk/StaticCache.js`: `.spoint-cache/static/<fnv1a(abs path)>-<basename>.<br|gz>` + `.meta {src, stamp, codeVersion}`; `SPOINT_STATIC_CACHE_DIR` overrides; Brotli q5.
- `client/service-worker.js` must branch on `DEV = /^(localhost|127.0.0.1|\[::1\]|0.0.0.0)$/` and serve `/node_modules/` and .wasm/.glb/.vrm/.ktx2/.hf network-first; production stays offline-first.

## Debugging discipline

- A bug surviving a threshold change was not fixed; re-diagnose. A fix failing end-to-end at its own layer means another copy of the same check exists (`src/physics/ShapeBuilder.js`, `cluster-lod-mesh.js`).
- `src\win\async.c, line 76` is libuv 1.51.0's `uv_async_send` assert; it fires at `process.exit()` with handles mid-close, so headless scripts await `process._getActiveHandles()` reaching 0, and a green path can surface as exit 127.
- A witness needing the server to act on a client message passes `--params=multiplayer`; `?singleplayer` sees `players:0` and acks `ok:false`. `net::ERR_ABORTED` is a cancellation; only a real failure or `HTTP >= 400` fails an arm.
- The shader prewarm manifest is derived from the world def's entity `model` urls, capped at `MAX_UNMANIFESTED_WARMUP_MESHES` = 50 (`client/core/SceneSetup.js:314`); no `shadermanifest.json` is ever requested.
- A harness returning an uncompared `{expected, got}` passes either way: one `expect()` per measurement plus non-zero exit.
- `window.__spoint._drive` is `client/core/Relocation.js drive()`, called by `app.js` each input step; wrapping it is the sanctioned way to OBSERVE input. `?multiplayer`: 767 input steps in 11.6 s, 15.0 ms input period.

## Entry points

- `ctx.defineGameFSM(spec)` `src/behaviours/game-fsm.js`; `client/core/ClientMachine.js` is xstate5 parallel, fallback `after:` 10 s gated / 45 s hard stop; editor REPARENT/DUPLICATE/SET_LABEL are 0x94-0x96.
- Default world `apps/world/index.js` `defaultWorld`; validated `src/shared/worldResolve.js`, defaulted `src/shared/worldDefaults.js` (tick 60, spawn [0,5,0], `DEFAULT_PLAYER_MODEL` `/assets/default-avatar.vrm`).
- Test relocation: `window.__spoint` + `MSG.TELEPORT` (0xc2 / TELEPORT_ACK 0xc3, `src/sdk/Relocation.js`; no `EDITOR_TOKEN` = any client, world def `relocation:false` disables, >87 deg from the anchor refuses).
- A client app's `ctx.state` is the entity's `custom` block (`client/AppModuleSystem.js:82`), not server app state (`src/apps/AppRuntime.js:686`), so `ctx.state.<key> ?? literal` takes the literal forever.
- Wireweave attach helpers run after awaits, so the object a guard tested is not the one the call dereferences (host migration reassigns `client` at `app.js:2666`); re-check at call time (`d6cf7bc7`).
- `createServer()` is a per-call factory (RoomDirectory hosts N rooms per process), but `getJolt()`'s compiled WASM, `boot()`'s SIGINT/SIGTERM handlers (use `RoomDirectory.stopAll`).
- APP_EVENT payloads arriving before the client app module is evaluated are dropped by `onEvent`; pushes at `player_join` land in that window.
- `onCollision` fires only between two entities whose apps BOTH define it.

## Fire (`ctx.defineFire`, `src/behaviours/fire.js`)

- Integer-only kernel `src/shared/fire/fireKernel.js`; decisions from `hash(seed, step, face, I, J)`; no float, `Math.random` or `Date.now`. Cells are 2x2 veg placement cells (8 m); step boundaries are absolute ticks.
- `ctx.navCostAt(x,z)` returns 8 burning / 2 charred. `fire.sightBlocked` and `ctx.canSee` cost 4-10 us per ray; `canSee` is gated by smoke through `_fireNavByRuntime` at depth >= smokeBlockDepth (`eyeHeightM` 1.6).
- Fire wind: the weather vector is the base and the `hash(seed, step)` field (`src/shared/fire/fireWind.js`) is the gust, summed into one vector clamped to +-16 per axis.
- Per-cell initial fuel is not recomputable in the integer kernel (`classify()`, `src/terrain/VegPlacement.js:170-234`). Any per-tile array added to `snapshot()`/`restore()` must join `TILE_ARRAYS` (`fireKeyframe.js`) with a VERSION bump (now 6); a mirror on 5 diverges.
- A tampered keyframe is rejected at DECODE with a named `[fireKeyframe]` error; every read is bounds-checked. `G` is the ignition step mod 256, not an age; `slot = slot*64 + (J&7)*8 + (I&7)`; IGNITE_AREA is kind 5, radius <= 8 cells.

## Planet-wide multiplayer (`src/shared/clusterAssignment.js`)

- One server world per cluster, each its own flat chart. The Jolt wasm heap is fixed at 134217728 B and never grows; over it `new J.JoltInterface` raises `Aborted(OOM)` (`src/physics/World.js:60`).
- The three limits are not the same cap: `maxContactConstraints` under requirement drops contacts silently; `maxBodies` under population makes Jolt return body id 0, so overflow bodies share one map key and `destroy()` aborts the wasm.
- Assignment is pure, deterministic, hysteretic, antipodal-safe, 2-4 Hz. `resolveClusterConfig` refuses a link below the relevance ring or the longest weapon range.
- Collider rings (`src/terrain/ColliderStreamer.js`): `DEFAULT_MAX_CENTERS = 192` for BOTH trunk and rock streamers (`1d8358bf`); rings are per connected player, never the centroid.
- `classifyRings`' per-cluster quota resets every pass and is first-fill, not a guarantee; `evictOverCap` removes farthest-first.
- The boot ring is placement-generation-bound: 2.242 ms/chunk trunk, 0.883 ms/chunk rock, against `COMPUTE_BUDGET_MS` 2.5 ms.

## Chart re-anchor

- Chart-local server holders migrate through `src/sdk/chartState/` (`attachServerChartMigrators(ctx, service)`; default off).
- A re-anchor is a change of basis, not a rotation: position, velocity, forward invariant.
- CHART_REANCHOR is 0xc6; epoch u32 rides the snapshot header and input/fire/teleport messages.
- Jolt recycles removed bodies' tree nodes only in `physics.step`, so re-adding thousands of bodies with no step between aborts the wasm; static migration ~22 us per flip. One re-anchor costs 0.17-0.45 ms.
- Flat chart + global gravity carries an intrinsic tilt term. Fixed by shrinking the chart: `CHART_ANCHORS_PER_FACE = 32` (`src/shared/chartAnchor.js`, `b6af3ff0`), worst cell angle 2.26 deg.
- `createChartAnchorLattice(radius, anchorsPerFace)`: 3/face = 54 anchors, worst cell-corner angle 21.235 deg; 6/face = 216, 11.309 deg. `CHART_REANCHOR_ANGLE_DEG` (28 / 14) must exceed the worst cell-corner angle or the anchor thrashes.
- There is exactly ONE chart per world (`setupTerrainStreaming` calls `createPlanetFrame` once), so two players at separation Delta each sit at Delta/2 and are walkable iff `terrainTilt + Delta/2 <= 45 deg`.
- `ChartReanchorTerrain.js`: HeightfieldStreamer fields are REBUILT off-path (`prepareFields` 1.0-1.7 s CPU in 2 ms slices, `installPrepared` 1.2-2.1 ms); ColliderStreamer rings transform in place via `setBodyTransform`.
- `src/shared/MinimapBiome.js sampleMinimapCell` returns `elevationAtLocal(frame,x,h,z)`, chart-independent to <0.0004 m; the old `frame.groundHeightLocal` differed between charts by anchor height + `sphereDropBelowTangent`.

## Physics and Jolt

- `BodyInterface.GetPosition` returns ONE shared temp; two calls alias (`addConstraint` must read default anchors via `getBodyPosition`, or the distance constraint gets min=max=0).
- A forced `removeBody(id, true)` destroys the body, and a cached shape dies with the LAST body that used it.
- `src/apps/AppRuntimePhysics.js` skips `e._vehicleId != null` in BOTH `_tickPhysicsLOD` and `_enforceBodyBudget`. `HeightFieldShape` quantizes over its own min/max.
- Heightfield samples snap to 1 mm with a deliberate `+ 0`: `Math.round` of a sample in (-0.5 mm, 0) yields -0, and -0 and +0 are different bits in a `Float32Array`.
- `removeBody` on a shapeKey-pooled DYNAMIC body must `DeactivateBody` and zero linear+angular velocity; pool revive must activate and zero both.
- `physics.setBodyMotionType` returns the NEW live body id on success or `false`, never the old id: a Jolt body created static cannot be made to simulate by `SetMotionType`.
- `src/physics/VehiclePhysics.js`: never `J.destroy` `v.constraint`/`v.tester` after `RemoveConstraint` and never destroy `get_mTracks()` copies after `set_mTracks`; `mDifferentials` defaults empty = zero wheel torque.
- `apps/_lib/softbody.js`: EVERY particle body needs a massed collider, pinned or not; each cloth owns its own `RAPIER.World`, never shared with Jolt.
- EDITOR_UPDATE must call `syncEntityCollider` AFTER `appRuntime.changeBodyType` (which removes the body and synthesizes a default box `_bodyDef`, clobbering `custom._collider`).
- `StaticTileIndex.update` stores the 16-value bounds record in a `Float64Array` and compares the integer tile span (3.3879 -> 0.7946 us/call).

## Terrain and colliders

- `solveSurfaceY` is absolute `1e-4` (`SURFACE_SOLVE_TOLERANCE_M`, `src/terrain/PlanetFrame.js:3`) with a 64-eval cap and throws `SurfaceSolveError`; past 63.6 km it returns `-(R+anchorHeight)` = -63682.687 with NO throw.
- A world with no terrain is FATAL: `ServerAPI.loadWorld` rethrows `[terrain] world "<id>" has no terrain`; every caller stops the server it created first (a leaked server holds the 128 MiB heap).
- Two height backends: `scripts/lib/gpu-eval.mjs` exposes `__sampleHeights(dirs)`. 25 samples over 256 m: v2 mean 0.001 / max 0.005 m; v1 mean 1.288 / max 2.840 m.
- Carves (`terrain.carves [{center,radius,falloff}]`, `src/shared/terrainConfig.js terrainCarvesOf`) are v2-only. v2 also replaced GPU cos/sin with f32 `OCTAVE_ROTATION_COS/SIN` tables.
- On a hashVersion 1 boot the frame ground is the GPU patch collider while `frame.elevationAtDir` is still the CPU sampler.
- `elevationAtLocal(frame,x,y,z)` is exactly `|p|-radius`. v1 CPU consumers: `src/shared/MinimapBiome.js`, `src/shared/relocation.js`, `src/terrain/PlacementChart.js`. App-facing `ctx.terrainHeightAt` is NOT one.
- `PlanetFrame.groundHeightLocal` memoises (direct-mapped 4096 slots, keyed by EXACT `(x,z)` + chartEpoch, caching `SurfaceSolveError` too): 64 stationary players 22 us/tick vs ~10.8 ms, bit-identical to the uncached frame.
- A heightfield's sample grid covers a half-open cell span, so neighbouring patches disagree along their shared edge by up to a quantization step (seam max 0.014895 m).
- The bake's row-major sweep seeds each solve from the previous cell (3.1247 -> 2.2310 samples per cell); a cell that fails to solve resets the guess to NaN.
- GPU bake vs JS `composeHeight` agree only to ~1e-5 relative: float32 GPU-internal directions diverge through `value_ridged_fbm_rot`'s 18-octave w-feedback.
- `terrain.glsl` `snoise3`/`vnoise2`/`seaHash`/`hpfSample` take the in-cell fraction as `P-floor(P)` from ONE `floor` result.
- The cube-face frame is duplicated across `terrain.glsl faceFrame()`/`hpfFaceUV()`/`faceWarp`, `gl-render.js _faceFrames`, and `FACE_FRAME` in `planet-orchestrator-cull.js`, `patch-baker.js`, `anchor-field-bands.js`.
- The server terrain collider lives in ONE fixed-anchor local tangent plane (`createPlanetFrame`, `anchorDir` default [0,1,0], never re-anchored), so it cannot represent world directions beyond ~87 deg from the anchor.
- `gl-render.js sampleGroundM` is fire-and-forget async (PBO+fence): each call returns the PREVIOUS call's harvested height; non-rAF callers must use `sampleGroundMSync`, which poisons the next async collision read.
- Chunk placements are memoized for the world lifetime, so BiomeOverride paints must call `clearChunkCache()`.
- `src/terrain/VegPlacement.js` and `src/terrain/RockPlacement.js` read the climate before `surfaceOfCell` only when `climateUsesLocalXZ !== true`: sea-level XZ and surface XZ diverge by ~h*sin(theta) (~30 m at 20 km).

## Netcode and wire

- Replay/lockstep drift comes from dt, not Jolt (1e-6 relative dt error is 0.75 mm/tick).
- Client-side prediction runs no collision, so `resimulate()` walks the local character into geometry it is held against; fix is a wedge flag gating the resim step when held.
- Client peer separation is a win: `src/netcode/CollisionSystem.js applyPlayerCollisions` pushes overlap/2 per tick. At 0/0/0: 0.1943 and 0.2049 corrections/ack vs 0.7422 control — near 0.74 is push-OFF regardless of the flag.
- `src/protocol/msgpack.js` `WIRE_STRUCTURES[1]` must list exactly the keys, in order, of `TickHandler.js _packPayload` (seq,tick,serverTime,players,entities,removed,delta,dots.
- msgpackr 2.0.4 writes -0 as the single byte `0x00`, so every peer decoded +0; `scripts/patch-deps.mjs` (postinstall) excludes -0 from both integer tests and runs strict.
- Wire v3 player record: 8 fields in a 22-byte bin; recipient-only `[inputSequence, inputBuffer, groundNormal]` travel in the per-recipient `me` block, so snapshots pack per recipient.
- `getSnapshot()` is keyed on `_version === _snapshotVersion` alone (the tick is gone) and a per-runtime map reuses an entity's encoding when a field-by-field compare finds nothing changed.
- `SnapshotGroupPlanner`: groups = `ceil(viewers*perViewerMs/(budgetMs-fixedMs))`, budget = tick period * `SNAP_COST_HIGH_FRAC` 0.35 (`src/sdk/TickHandler.js:30`), medians over the last 32 non-keyframe passes.
- Interest management is off by default: `relevanceRadius || 0` (`src/sdk/server.js:67`) makes `playersInInterest` return every player, and no world sets it; the 3.6-6.7 KB/s in `docs/netcode.md` is that harness, not a scaling claim.
- Lockstep: rollback is input-capped; measure by depth, not rate (`maxRollbackTicks` 12). `inputDelayTicks` above `INPUT_RETAIN_TICKS` (240) throws at construction.
- Any new per-tick gameplay timer in `AppRuntime` is tick-indexed, never `Date.now()` (`_interactCooldowns` stores `runtime.currentTick + ticks`): a wall-clock expiry desyncs under resim.
- Raw ws clients (`scripts/perf-gate.mjs`, `verify-session.mjs`) mirror `COALESCE_SENTINEL`/`splitCoalesced`: `0xFF` then `[uint32 LE length][msgpack]` repeated; a plain `unpack()` of a coalesced frame throws.
- Collision mirror: `StaticTileIndex.js` tiles static non-sensor bodies at 16 m XZ (+3 m margin, `|y|<10000` to skip pool bodies parked at y=-100000).
- Authoritative-path structure: prediction is off by default (`client/app.js predictionEnabled` only with `?predict`); `INPUT_BACKLOG_DRAIN` merges <=2 queued inputs into the last (drops movement); rollback/lockstep are unwired.

## Rendering

- `WebGPURenderer` is the DEFAULT; `?legacygl=1` opts out, and if WebGPU is unavailable the code retries `WebGPURenderer(forceWebGL=true)` before ever falling back to legacy, so TSL stays the only shader path.
- `node_modules/three/build/three.webgpu.js` (pinned 0.185.1) calls `device.popErrorScope().then(fn)` with no rejection handler at 3 sites.
- WebGPU consumes TerrainBackdrop's `fE` matrix DIRECTLY as the per-vertex clip transform (`patch-grid-render.js` WGSL `out.pos = frame.viewProjNoEye * vec4(vRel,1.0)`) while WebGL uses `fE` only for CPU frustum culling, so a latent.
- `patch-grid-render.js _ensureInstanceBuffer` must NOT reference-equality-guard a reused array (`collectQuads()` reuses one `quadsPool` every frame; the guard froze WebGPU terrain at frame 1).
- Any hand-written `ShaderMaterial` reaching InstancedMesh2 grass/veg (`SSAO.js _gbufferVert`, `client/core/GrassMaterial.js`, `WeatherMaterials` splash) must `#include <instanced_pars_vertex>` and, under `USE_INSTANCING_INDIRECT`.
- `model-pool.js` frame-budgeted drains (`_drainLodWarm`, `_drainGpuWarm`, `_drainSpawnQueue`, `_drainClusterBuild`) must allow >=1 unit/frame even below target FPS or a zero budget deadlocks.
- `ClusterLodMesh._render` fires once PER GROUP per frame — keep the `_lastRenderFrame===frame` early-return, or a mid-frame cull/LOD re-run rewrites start/count of already-queued draws.
- `streaming-gltf webgpu-hiz-shaders.js` compute cull must stay algebraically equal to the CPU paths (HZB level = `hzb-tier.js _selectLevel`, occlusion = `isOccludedBox` with `minZ >= texel + 1e-5`.
- Vegetation LOD: a uniform grid classifies whole cells (`MAX_CELLS` bounds the loop by doubling cell size until it fits, `GRID_MIN_OCCUPANCY` keeps the flat scan for sparse instancers — the real world declines the grid).
- `scripts/veg-instance-browser-witness.mjs --gpu=amd|nvidia [--walk=ms --route=...]` passes on both real GPUs: vegTotal ~5000 settled, grass 7964, streamState missing=0 stale=0, no page errors.
- Legacy mixes the raw interpolated vertex normal (`shaders/terrain.glsl:781`) while TSL normalized it first (`tsl/terrain-material-tsl.js:163`); the default `reliefShade` 6 amplifies 0.53 / 0.73 into the 3.11 / 5.67 left-edge delta.
- Every discard in `terrain.glsl`'s FS must stay inside `#ifdef _WATERPASS_`: `gl-render` compiles the source twice (a discard anywhere disables early-Z depth write for all its draws).
- Depth contract: mapspinner re-encodes terrain/water depth to `window.__hostNearFar` (`gl-render.js passPlanetDepthWriteback`; WebGPU `vdrs-composite.js DepthWriteback`).
- Rendered sea = sphere R (== `PlanetFrame.waterlineLocalY`, exact to 1 cm) plus waves that must be ZERO-MEAN about it: the old VS `swellP=dot(dir0,tangent-from-dir0)*R` heaved the whole ocean -0.40..+0.40 m (mean +0.254).
- Sky: `gl-render.js` sky FS exposure is `mix(48, 14, sunElevDot)` — no single constant works across the day cycle.
- `display-referred-tsl.js invertAcesFilmic` must NOT end in `max(x, 0)`: a saturated blue (56,176,236) inverts to (-0.034,0.346,1.395) — negative red is out of AP1/ACES gamut — and clamping makes the re-encode 82.7 vs 55.9.
- Terrain wetness must stay displacement-masked puddles (the old uniform `pow(dot(n,H),24)*wet*0.5` gave +29..+43 luma glare).
- `ShadowPipeline.js forceUpdate` must set EVERY cascade `light.shadow.needsUpdate` (three gates per light); `cascadeCount` clamps to 1 when `sun.castShadow===false` — cascade 0 IS the sun, never renders.
- `client/core/QualityPresets.js` ships `ssao:false` (and `bloom:false`) on every preset because SSAO's half-res upsample leaves a persistent dark ground-level smear; the knobs stay live-toggleable via `?debugpanel=1`.
- `MapspinnerPipelineCache.getPipeline()` must error-scope `createRenderPipeline` (`pushErrorScope('validation')`/`popErrorScope`.
- Drivers evict texture memory on a long-backgrounded tab without firing `webglcontextlost`.
- Placement-height bakes moved off-thread (`packages/mapspinner/src/patch-baker-worker.js` + `patch-baker-remote.js`); `?patchbake=main` forces the old baker, also the fallback when the worker dies.
- `terrain.glsl` is the single source of truth for CPU/GPU height parity (`scripts/gen-height.mjs` transpiles it into height-gen.js/height-cpu.js); deleting GLSL needs a new source of truth plus a TSL/WGSL->JS generator.

## Client and app runtime

- HUD `applyDiff(uiRoot, hudVdom)` replaces uiRoot's children every frame, so imperative DOM overlays (lobby, EmoteWheel, PauseMenu, SettingsMenu, MinimapHUD) mount on `document.body`.
- Scenery: `_buildWorldScenery` is a joinable wrapper; boot adopts the running build (`Promise.race` does not cancel the loser). The adopt branch must not be gated on `window.__terrain` (`b69c7754`).
- `app.js animate()` returns early while `window.__warmupInFlight`; two interleaved `renderer.render` passes on one GL context let `ClusterLodMesh onBeforeRender` rewrite shared geometry.groups/index mid-pass.
- Hot reload releases a ctx via `AppRuntime._releaseAppContext`; `update()` keeps running with a torn-down ctx unless `_updateList`/`_rebuildCollisionList` are rebuilt.
- `AppRuntime._attachApp` does `apps.set` BEFORE awaiting `setup()`.
- Spawn: `holdSpawnUntilGrounded` (`src/sdk/Relocation.js:71`) gates release on `terrainFieldMissingAt`/`coversPosition` (max `SPAWN_HOLD_MAX_MS=20000`).
- Lifecycle traps: `AppRuntime.spawnEntity` attaches each app fire-and-forget, so collect tagged entities on the first `update()` tick.
- `client/BrowserServer.js`: `_lastTodSync` and `_deliveredWorldFingerprints` are MODULE level because stall recovery and HostMigration rebuild a fresh BrowserServer in the same page.
- Singleplayer worker world identity comes from `INIT.worldName`; the snapshot is one IDB key `world-snapshot` per origin, so switching worlds discards by mismatch (`7d29891a8e`).
- Vegetation `InstancedMesh2`: `sortObjects` must stay false with LODs; `CullFreeze.js setInstancedCullAuto` sets `autoUpdate` on parent AND every LOD level (3.7 ms/frame otherwise).
- `client/core/FloatingOrigin.js update()` must `camera.position.set(0,0,0)` on rebase, not `+= -delta`: `app.js` rewrites `camera.position` from authoritative coords every frame before `update()`.
- `planet.html` runs its whole init chain inside `frameLoop` and rAF never fires in hidden tabs, so a 250 ms `setInterval` ticks it while `document.hidden`; `scheduleFrame` is single-flight.
- `src/client/PredictionEngine.js` is under `src/client/`, not `client/`.
- `client/core/MobileControls.js setGyroAimEnabled(true)` calls `DeviceOrientationEvent.requestPermission()`, which iOS 13+ grants only from inside a click/touch handler.
- `client/EntityLoader.js _primGeoKey` must use the same ||-defaults as `EntityLoaderMeshBuild MESH_BUILDERS` (capsule r0.3/h1.8 also mirrors the AppPhysics capsule collider and EditorHandlers).

## Measurement and witnessing

- Witnesses can launch Chromium on SwiftShader silently, so timing gates were software numbers; `scripts/lib/gpu-probe.mjs assertGpu` after navigation — and assert the REQUESTED adapter. The AMD adapter LUID is per-boot (62340 today): `adapterLuidFor('amd')` reads it from the DirectX registry each run, and `--use-adapter-luid=0,<luid>` with a stale value silently runs the NVIDIA arm.
- `scripts/frame-time-gate.mjs` writes a PER-VENDOR baseline (`.frame-time-baseline.<vendor>.json` per `--expect-vendor=`); `frame-time-baseline.mjs baselineRefusals` rejects one captured on another adapter vendor. rAF is vsync-locked unless Chromium is launched with `--disable-frame-rate-limit --disable-gpu-vsync`, so a locked p50 is a refresh divisor (144/1 = 6.94 ms static, 60/1 = 16.67 orbit, on ONE page) not work; unlocked static was 18.25 ms.
- On the WebGPU backend `renderer.info.render.triangles` and `.drawCalls` read 0 and only `info.render.calls` moves, so a reached-triangles arm can never pass there: the gate exempts it only when the backend reports isWebGPU, requiring draw calls, frames and `window.__vegProfile.totalInstances`, plus orbit triangles >= 50% of static so the orbit arm cannot measure an empty view. Its camera is posed off the live player (player + 50,10,+50) at `?at=-15,-12.5`, or it frames empty ground while vegetation streams elsewhere.
- A ms-per-tick counter is not a measurement: two arms of one build moved `_lastCollisionMs` 0.310 -> 0.423 (+37%) while work-unit counters moved under 1%; decide perf rows on counted work units.
- Wall clock vs CPU: a wall-clock ms/s gate on a shared box measures the box — the same ring-scale arm read 147.78 and 73.55 ms/s with every work counter identical.
- A counter the code never increments is a silent pass: `physics.getBodyCount` and `collectMs`/`collectCount` did not exist, so two gates compared `null` and passed every run.
- `npm test` ends with `scripts/fire-witness-gate.mjs`: a witness must exit 0 AND print `RESULT: PASS`, capped at 600 s so a hang fails CI.
- Draw-count instruments: authoritative = `perf-run.mjs drawsInstrument.authoritativeField` (`wgpuDrawsPerFrame`/`glDrawCallsPerFrame`) = 141, the per-frame DELTA of `info.render.drawCalls` since `8f5214d164`.
- CDP `Input.dispatchKeyEvent` in `scripts/perf-run.mjs` reaches Chrome but never sets the app's input bucket (60 s of KeyW moved 0.9 m); `nav->inputAccepted` is not an input-acceptance metric.
- A walk witness must measure accumulated path length (sum of sampled position deltas), never net displacement: a walker that reaches its waypoints and then stalls against arena geometry reads 18.47 m net for a 150 m walk.
- Two harness reports are comparable only on the same code — check mtimes of every source file a report depends on.
- TSL-vs-legacy parity criterion (written BEFORE any frame): a region matches iff cross-renderer meanAbs/channel <= 3 x max(same-renderer noise floor, `QUANT_FLOOR` 1.0); if the two GPUs' floors differ >3x the result is INDETERMINATE.
- gm `exec_js` dispatches are ephemeral, isolated worker contexts: a server booted in one dispatch is gone by the next (ECONNREFUSED); detached+unref spawn dies too (Windows Job Object).
- Screenshot traps: `TerrainBackdrop.renderPlanet` rebuilds eye/target from `camera.getWorldDirection()` and is BROKEN for a manually posed camera (pure sky.
- Pre-change control for a converted witness that fails: gm `git_show {path, rev:"HEAD"}`, write to `scripts/.<name>.mjs` so `./lib/...` imports resolve, run, delete.
- Measured win not to be undone: `Weather.js _respawnDroplet/_respawnFlake` re-sampled `frame.groundHeightLocal` at a brand-new random position on every recycle (~26k calls/s = 65% of all sampling).
- Environment: `localhost` resolves ~200 ms vs `127.0.0.1` 5 ms — use the literal IP in harnesses. Snapshot bundles with `cp -p`, never `cp` (mtime is the comparability check).

## Security

- A HiddenSpawn second-stage loader was found and cleaned 2026-09-29 (`70cfe04f`): a `.env` plus 16 lines in `src/fluid/as-src/sph.ts`.
- `SESEvaluator` fails closed with no proxy tier; `StaticHandler` enforces path containment and COEP `require-corp`; `server-http-auth-matrix` holds the route/auth table.
- `src/sdk/SESCompartmentEvaluator.js` is the only untrusted-app evaluator; a failed `import('ses')`/lockdown throws `SandboxUnavailableError` (SANDBOX_UNAVAILABLE); first-party `apps/` never touch it.
- `src/sdk/authCompare.js timingSafeTokenEqual` runs a self-compare (`bufA,bufA`) on a length mismatch before returning false, so every path costs one constant-time compare and token length is not leaked — do not simplify it away.
- Benign exec surfaces, never flag as malware: `lang/spoint.js` (gm exec plugin), `mapspinner/planet.html` pollCmd eval, `scaffold.js` npx, `cdp-browser.mjs` curl relay.

@.gm/next-step.md
