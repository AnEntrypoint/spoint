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

Fewest words per fact; numbers and scenarios live in the `project/*` memo tier.

- Memo tier: `mem-0b6d4c2f9e1a8735-1204` measurement/GPU · `mem-1c7e5d3a0f2b9846-2315` physics/terrain · `mem-2d8f6e4b1a3c0957-3426` netcode · `mem-3e9a7f5c2b4d1068-4537` rendering · `mem-4f0b8a6d3c5e2179-5648` fire/cluster/chart.

## Working rules

- Main-only branch; commit only as lanmower (`git_commit` explicit `paths`, never `git add` + bare commit, `0292ad7b`). AI co-author trailers are one-way (`auto-declaudeify.yml`).
- Generated artifacts travel with source: `src/apps/AppContext.js` -> `sdk-typings.generated.d.ts`; a height-code change re-bakes `apps/world/*.hf`.
- `core.autocrlf=true`: tree CRLF, index LF; `w/crlf` in `git ls-files --eol` is not a diff. Green locally + red in CI on untouched files = line-ending or path case.
- `@spoint/ecs` is the only `@spoint/*` specifier; its link vanishes mid-session and kills every harness. `npm run links` restores it; never `npm install`.
- `gpulock.mjs run <owner> bash ...` exits 127 — pass the node binary + a `.mjs` script. It returns 0 even when the witness failed: grep the run's log for `RESULT:`. `gpulock status` `held:false, stale:true` = lock free, stale holder never resumed.
- Never `git worktree remove` a `scripts/worktree-setup.mjs` worktree (its node_modules junction makes git delete main `node_modules/.bin`); use `node scripts/worktree-teardown.mjs <path>`.
- gm spool files `in/<verb>/<session_id>-<random8>.txt`, and the extension must be `.txt`: a `.json` in-file is swept without executing (no out file, no `dispatch.end` in `.watcher.log`). Never reuse a counter/suffix (returns a stale payload). codesearch sees the WORKING tree, so another lane's edit can hide a committed constant. Comment sweep: gm `grep` `{"mode":"comments","refresh":true}`; `exhaustive:false` = 200-match cap; `glob` matches FILENAMES.
- `npm run check` parses only tracked files under `src,client,apps,scripts,bin`: a 9-witness gpu-free arm (~30 s), then `fire-witness-gate.mjs` (exit 0 AND `RESULT: PASS`, 600 s cap), then `check-frame-time-baselines` (vendor baselines only), then the opt-in `SPOINT_GPU_WITNESS` veg arm; it refuses browser/GPU witnesses by name. Which witnesses belong there: `mem-0b6d4c2f9e1a8735-1204`.
- Ship an opportunity noticed in the same pass (before/after witness) or `prd-add` it. Unmeasured speedups never ship.

## Repo boundaries

- `design` ships as pinned CDN URLs in the importmaps of `client/{index,landing/index,editor/thebird-host}.html` + `scripts/bundle-client.mjs` (`anentrypoint-design` -> unpkg `1.0.34/dist/247420.{js,css}`).
- `vendor/*` are editing-only submodules: edit on their own `main`, push, then commit the gitlink; all UI is built in `AnEntrypoint/design`.
- `apps/*` must never import `client/*` (the singleplayer Worker resolves relative specifiers against a virtual root); expose utilities on `engineCtx` (`engine.createEmoteWheel`, `engine.THREE`, `ctx.kit`).
- Keep Node-only dynamic import specifiers opaque to esbuild/wrangler: build them in an IIFE, `(() => './' + 'ServerAPI' + '.js')()` (`EditorHandlers.js _serverApiPath`, `World.js getJolt`).
- `globalThis.__SPOINT_EDGE_BUNDLED__` is set at `jolt-edge-init.js` top level, so `edge/cf-do/spoint-do.js` must import it BEFORE `WorkerEntry.js`.

## Debugging discipline

- A bug surviving a threshold change was not fixed; re-diagnose. A fix failing end-to-end at its own layer means a second copy of the same check exists (`ShapeBuilder.js`, `cluster-lod-mesh.js`).
- `src\win\async.c:76` is libuv 1.51.0's `uv_async_send` assert; it fires at `process.exit()` with handles mid-close, so headless scripts await `process._getActiveHandles()` reaching 0 (a green path can surface as exit 127).
- A witness needing the server to act on a client message passes `--params=multiplayer`; `?singleplayer` sees `players:0`, acks `ok:false`. `net::ERR_ABORTED` is a cancellation; only a real failure or `HTTP >= 400` fails an arm. A harness returning an uncompared `{expected, got}` passes either way: one `expect()` per measurement plus non-zero exit.
- `window.__spoint._drive` is `Relocation.js drive()`, called by `app.js` each input step; wrapping it is the sanctioned way to OBSERVE input.
- Live GL debugging: full playbook in `mem-a6f1d7bd7be3412c-3784`. One `gl.getError()` code covers distinct bugs (1282 = feedback-loop, sampler-type-mismatch AND insufficient-buffer-size), so read the driver's OWN console string off a cache-disabled reload.

## Entry points

- `ctx.defineGameFSM(spec)` `src/behaviours/game-fsm.js`; `ClientMachine.js` is xstate5 parallel, fallback `after:` 10 s gated / 45 s hard stop; editor REPARENT/DUPLICATE/SET_LABEL are 0x94-0x96.
- `ctx.defineFire(spec)` `src/behaviours/fire.js` (wired at `AppContext.js:387`, default off, integer kernel in `src/shared/fire/`); design recall slug `project/fire-system-design-2026-10-05`.
- Default world `apps/world/index.js` `defaultWorld`; validated `worldResolve.js`, defaulted `worldDefaults.js` (tick 60, spawn [0,5,0], `DEFAULT_PLAYER_MODEL` `/assets/default-avatar.vrm`).
- Test relocation: `window.__spoint` + `MSG.TELEPORT` (0xc2 / TELEPORT_ACK 0xc3, `src/sdk/Relocation.js`; no `EDITOR_TOKEN` = any client, `relocation:false` disables, >87 deg from the anchor refuses).
- A client app's `ctx.state` is the entity's `custom` block (`AppModuleSystem.js:82`), not server app state (`AppRuntime.js:686`): `ctx.state.<key> ?? literal` takes the literal forever. `engine.cam` is the camera CONTROLLER (`client/core/camera.js createCameraController`, `yaw`/`pitch`/`punch`/`setMode`) with no `position`, so `engine.cam.position` throws on every event; read `engine.client.getLocalState().position` (`apps/tps-game/client-app.js`).
- Wireweave attach helpers run after awaits (host migration reassigns `client` at `app.js:2666`): re-check at call time (`d6cf7bc7`).
- `createServer()` is a per-call factory (RoomDirectory hosts N rooms per process); `getJolt()`'s WASM and `boot()`'s SIGINT/SIGTERM handlers are process-global: stop with `RoomDirectory.stopAll`.
- APP_EVENT payloads arriving before the client app module is evaluated are dropped by `onEvent`; pushes at `player_join` land in that window.

## Fire (`ctx.defineFire`)

- Integer-only kernel `fireKernel.js`; decisions from `hash(seed, step, face, I, J)`; no float, `Math.random` or `Date.now`. Cells are 2x2 veg placement cells (8 m); step boundaries are absolute ticks.
- `ctx.navCostAt(x,z)` returns 8 burning / 2 charred. `fire.sightBlocked`/`ctx.canSee` cost 4-10 us per ray; `canSee` is smoke-gated through `_fireNavByRuntime` at depth >= smokeBlockDepth (`eyeHeightM` 1.6).
- Fire wind: the weather vector is the base, the `hash(seed, step)` field (`fireWind.js`) the gust, clamped to +-16 per axis. Keyframe `snapshot().wind` carries the BASE only.
- Per-cell initial fuel is not recomputable in the integer kernel (`classify()`, `VegPlacement.js:170-234`); any per-tile array added to `snapshot()`/`restore()` must join `TILE_ARRAYS` (`fireKeyframe.js`) with a VERSION bump (now 6).
- A tampered keyframe is rejected at DECODE with a named `[fireKeyframe]` error; every read is bounds-checked. `G` is the ignition step mod 256, not an age; `slot = slot*64 + (J&7)*8 + (I&7)`; IGNITE_AREA is kind 5, radius <= 8 cells.
- Fire gate witnesses: `fire-smoke-los-witness.mjs`, `fire-wind-coupling-witness.mjs` (scenarios: `mem-4f0b8a6d3c5e2179-5648`).

## Planet-wide multiplayer (`src/shared/clusterAssignment.js`)

- One server world per cluster, each its own flat chart. The Jolt wasm heap is fixed at 134217728 B, never grows; over it `new J.JoltInterface` raises `Aborted(OOM)` (`src/physics/World.js:60`).
- The three limits are not the same cap: `maxContactConstraints` under requirement drops contacts silently; `maxBodies` under population makes Jolt return body id 0, so overflow bodies share one map key and `destroy()` aborts the wasm.
- Assignment is pure, hysteretic, antipodal-safe, 2-4 Hz; `resolveClusterConfig` refuses a link below the relevance ring or the longest weapon range.
- Collider rings (`ColliderStreamer.js`): `DEFAULT_MAX_CENTERS = 192` for BOTH trunk and rock streamers (`1d8358bf`); rings are per connected player, never the centroid. `classifyRings`' per-cluster quota resets every pass, first-fill, not a guarantee; `evictOverCap` removes farthest-first.
- Boot ring is placement-generation-bound: 2.242 / 0.883 ms per chunk (trunk / rock) against `COMPUTE_BUDGET_MS` 2.5 ms.

## Chart re-anchor

- Chart-local server holders migrate through `src/sdk/chartState/` (`attachServerChartMigrators(ctx, service)`; default off); a re-anchor is a change of basis, not a rotation.
- CHART_REANCHOR is 0xc6; epoch u32 rides the snapshot header and input/fire/teleport messages.
- Jolt recycles removed bodies' tree nodes only in `physics.step`: re-adding thousands of bodies with no step between aborts the wasm. Cost: `mem-4f0b8a6d3c5e2179-5648`.
- The flat chart's intrinsic tilt term is fixed by shrinking the chart: `CHART_ANCHORS_PER_FACE = 32` (`chartAnchor.js`, `b6af3ff0`), worst cell angle 2.26 deg. `CHART_REANCHOR_ANGLE_DEG` (28 / 14) must exceed the worst angle of the `createChartAnchorLattice` lattice or the anchor thrashes.
- Exactly ONE chart per world (`setupTerrainStreaming` calls `createPlanetFrame` once), so two players at separation Delta sit at Delta/2, walkable iff `terrainTilt + Delta/2 <= 45 deg`.
- `ChartReanchorTerrain.js`: HeightfieldStreamer fields are REBUILT off-path in slices, then installed; ColliderStreamer rings transform in place via `setBodyTransform`.
- `MinimapBiome.js sampleMinimapCell` returns `elevationAtLocal(frame,x,h,z)`, chart-independent to <0.0004 m.

## Physics and Jolt

- `BodyInterface.GetPosition` returns ONE shared temp; two calls alias (`addConstraint` must read default anchors via `getBodyPosition`, or the distance constraint gets min=max=0).
- `AppRuntimePhysics.js` skips `e._vehicleId != null` in BOTH `_tickPhysicsLOD` and `_enforceBodyBudget`. `HeightFieldShape` quantizes over its own min/max.
- Heightfield samples snap to 1 mm with a deliberate `+ 0`: `Math.round` of a sample in (-0.5 mm, 0) yields -0, and -0 and +0 differ as `Float32Array` bits.
- A forced `removeBody(id, true)` destroys the body, and a cached shape dies with the LAST body that used it.
- `physics.setBodyMotionType` returns the NEW body id or `false`, never the old; a body created Static cannot be made to simulate by `SetMotionType` in jolt-physics 1.1.0 wasm-compat (`IsActive()` is the only discriminator), so it falls back to recreation.
- Recreation must CREATE the new body BEFORE destroying the old (destroy-first frees a cached shape the new still points at: `null function or function signature mismatch`), puts it on `LAYER_DYNAMIC`, and refuses a body holding a constraint, vehicle chassis or trimesh/mesh/heightfield shape.
- A pooled body whose `bodyMeta.type` differs from the requested motionType must be destroyed and replaced (`AppPhysics.scaledShapeKey()` encodes model|scale only); a matching slot is revived via `_revivePooledBody` (reposition, zero both velocities, `ScaleToMass`, refresh `bodyMeta`), and forced destroy evicts it. `removeBody` on a pooled DYNAMIC body must `DeactivateBody` and zero both velocities; revive must activate and zero both.
- `VehiclePhysics.js`: never `J.destroy` `v.constraint`/`v.tester` after `RemoveConstraint`, never destroy `get_mTracks()` copies after `set_mTracks`; `mDifferentials` defaults empty = zero wheel torque.
- `apps/_lib/softbody.js`: EVERY particle body needs a massed collider, pinned or not; each cloth owns its own `RAPIER.World`.
- EDITOR_UPDATE must call `syncEntityCollider` AFTER `appRuntime.changeBodyType` (which removes the body and synthesizes a default box `_bodyDef`, clobbering `custom._collider`).
- `StaticTileIndex.update` stores the 16-value bounds record in a `Float64Array` and compares the integer tile span; it tiles static non-sensor bodies at 16 m XZ. Numbers: `mem-1c7e5d3a0f2b9846-2315`.

## Terrain and colliders

- `solveSurfaceY` is absolute `1e-4` (`SURFACE_SOLVE_TOLERANCE_M`, `PlanetFrame.js:3`), 64-eval cap, throws `SurfaceSolveError`; past 63.6 km it returns `-(R+anchorHeight)` = -63682.687 with NO throw.
- No terrain is FATAL: `ServerAPI.loadWorld` rethrows `[terrain] world "<id>" has no terrain`; every caller stops the server it created first.
- Two height backends; `gpu-eval.mjs` exposes `__sampleHeights(dirs)`. Over 25 samples across 256 m: v2 mean 0.001 / max 0.005 m, v1 mean 1.288 / max 2.840 m. Carves (`terrainConfig.js terrainCarvesOf`) are v2-only.
- On a hashVersion 1 boot the frame ground is the GPU patch collider while `frame.elevationAtDir` is still the CPU sampler.
- `elevationAtLocal(frame,x,y,z)` is exactly `|p|-radius`. v1 CPU consumers: `MinimapBiome.js`, `relocation.js`, `PlacementChart.js`. App-facing `ctx.terrainHeightAt` is NOT one.
- `PlanetFrame.groundHeightLocal` memoises (4096 direct-mapped slots keyed by EXACT `(x,z)` + chartEpoch, caching `SurfaceSolveError` too). Cost: `mem-1c7e5d3a0f2b9846-2315`.
- A heightfield's sample grid covers a half-open cell span, so neighbours disagree along a shared edge by a quantization step (seam max 0.014895 m); the row-major bake sweep seeds each solve from the previous cell. Parity and cost: `mem-1c7e5d3a0f2b9846-2315`.
- `terrain.glsl` `snoise3`/`vnoise2`/`seaHash`/`hpfSample` take the in-cell fraction as `P-floor(P)` from ONE `floor`. The cube-face frame is duplicated across `terrain.glsl faceFrame()`/`hpfFaceUV()`/`faceWarp`, `gl-render.js _faceFrames`, `FACE_FRAME` in `planet-orchestrator-cull.js`, `patch-baker.js`, `anchor-field-bands.js`.
- The server terrain collider lives in ONE fixed-anchor local tangent plane (`createPlanetFrame`, `anchorDir` default [0,1,0], never re-anchored): it cannot represent directions beyond ~87 deg from the anchor.
- `gl-render.js sampleGroundM` is fire-and-forget async (PBO+fence): each call returns the PREVIOUS call's harvested height; non-rAF callers must use `sampleGroundMSync`, which poisons the next async collision read.
- `VegPlacement.js`/`RockPlacement.js` read the climate before `surfaceOfCell` only when `climateUsesLocalXZ !== true` (sea-level XZ and surface XZ diverge by ~h*sin(theta)). Veg density must gate on painted snow, or the 1-2% of grass weight surviving a snow cell still roots trees.

## Netcode and wire

- Replay/lockstep drift comes from dt, not Jolt (1e-6 relative dt error is 0.75 mm/tick). Client-side prediction runs no collision, so `resimulate()` walks the local character into geometry it is held against; the fix is a wedge flag gating the resim step when held.
- Client peer separation is a win: `CollisionSystem.js applyPlayerCollisions` pushes overlap/2 per tick; ~0.74 corrections/ack means push-OFF regardless of the flag (0.19-0.20 with it on).
- `msgpack.js` `WIRE_STRUCTURES[1]` must list exactly the keys, in order, of `TickHandler.js _packPayload` (seq,tick,serverTime,players,entities,removed,delta,dots). msgpackr 2.0.4 writes -0 as the byte `0x00`, so every peer decoded +0; `patch-deps.mjs` (postinstall) excludes -0 from both integer tests.
- Wire v3 player record: 8 fields in a 22-byte bin; recipient-only `[inputSequence, inputBuffer, groundNormal]` ride the per-recipient `me` block, so snapshots pack per recipient.
- `getSnapshot()` is keyed on `_version === _snapshotVersion` alone (the tick is gone); a per-runtime map reuses an entity's encoding when a field-by-field compare finds no change.
- `SnapshotGroupPlanner`: groups = `ceil(viewers*perViewerMs/(budgetMs-fixedMs))`, budget = tick period * `SNAP_COST_HIGH_FRAC` 0.35 (`TickHandler.js:30`). Interest management is off by default: `relevanceRadius || 0` (`server.js:67`) makes `playersInInterest` return every player and no world sets it.
- Lockstep: rollback is input-capped; measure by depth, not rate (`maxRollbackTicks` 12). `inputDelayTicks` above `INPUT_RETAIN_TICKS` (240) throws at construction. Any new per-tick gameplay timer in `AppRuntime` is tick-indexed, never `Date.now()` (`_interactCooldowns` stores `runtime.currentTick + ticks`).
- A socket becomes a player by MIGRATE, by RECONNECT, or by staying silent past the MIGRATE-peek grace timer (`ServerHandlers.js onClientConnect`, 50 ms, 1500 ms under tick dilation), so a probe joins as a phantom until its close lands. Probes use `?probe=1` (`attachWSHandlers` marks the transport `probeOnly`; close after 10 s). Never answer an unresolvable RECONNECT with INVALID_SESSION and leave the socket open; `ServerHandlers rejectSession` flushes the reason and closes, `PhysicsNetworkClient._dropSessionAndReconnect` drops the token and reconnects, a refused MIGRATE closes the candidate without spawning.
- Migration keeps the old transport as a fallback owner and hands the player back on candidate death; a close from a transport the client no longer owns cannot tear it down. `scripts/transport-churn-witness.mjs` covers arms A-F. Scenarios: `mem-2d8f6e4b1a3c0957-3426`.
- Raw ws clients (`perf-gate.mjs`, `verify-session.mjs`) mirror `COALESCE_SENTINEL`/`splitCoalesced`: `0xFF` then `[uint32 LE length][msgpack]` repeated; a plain `unpack()` of a coalesced frame throws.
- Authoritative path: prediction is off by default (`app.js predictionEnabled`, only `?predict`); rollback/lockstep are unwired. `TickHandler.js processPlayerMovement` takes ONE input per tick and catches up only while `inputs.length > INPUT_BUFFER_CATCHUP_DEPTH` 8, `extra < MAX_CATCHUP_STEPS_PER_TICK` 3, `player.inputStepBudget >= 1` and no sequence gap ahead; `accrueStepBudget` clamps the bank to `[-1, INPUT_STEP_BANK 16]` as `budget + elapsedSteps - stepsTaken`. That bank is the only thing standing between a fast client and 4x-real-time movement, so never remove the `inputStepBudget >= 1` gate to make a backlog drain faster.

## Rendering

- `WebGPURenderer` is DEFAULT (`?legacygl=1` opts out); unavailable WebGPU retries it with `forceWebGL=true` before legacy, so TSL is the only shader path.
- `three.webgpu.js` (pinned 0.185.1) calls `device.popErrorScope().then(fn)` with no rejection handler at 3 sites: destroying the GPUDevice with a scope pending rejects into an unhandled `OperationError`; `scripts/patch-deps.mjs` patches all three.
- WebGPU consumes TerrainBackdrop's `fE` DIRECTLY as the per-vertex clip transform (`patch-grid-render.js` WGSL `out.pos = frame.viewProjNoEye * vec4(vRel,1.0)`); WebGL uses `fE` only for CPU frustum culling.
- `patch-grid-render.js _ensureInstanceBuffer` must NOT reference-equality-guard a reused array (`collectQuads()` reuses one `quadsPool` every frame; that guard froze WebGPU terrain at frame 1).
- Hand-written `ShaderMaterial` reaching InstancedMesh2 grass/veg (`SSAO.js _gbufferVert`, `GrassMaterial.js`, `WeatherMaterials` splash) must `#include <instanced_pars_vertex>`, and under `USE_INSTANCING_INDIRECT`.
- `model-pool.js` frame-budgeted drains (`_drainLodWarm`, `_drainGpuWarm`, `_drainSpawnQueue`, `_drainClusterBuild`) must allow >=1 unit/frame even below target FPS, or a zero budget deadlocks.
- `ClusterLodMesh._render` fires once PER GROUP per frame: keep the `_lastRenderFrame===frame` early-return, or a mid-frame cull/LOD re-run rewrites start/count of queued draws.
- `webgpu-hiz-shaders.js` compute cull must stay algebraically equal to the CPU paths (HZB level = `hzb-tier.js _selectLevel`, occlusion = `isOccludedBox` with `minZ >= texel + 1e-5`).
- Vegetation LOD: a uniform grid classifies whole cells (`MAX_CELLS` bounds the loop by doubling cell size until it fits; `GRID_MIN_OCCUPANCY` keeps the flat scan for sparse instancers).
- `client/core/PlacementRing.js keysAround` must return `PlacementLattice.ringAroundDir`'s numeric chunk keys UNCHANGED (`90c2bcad`) and throw on a non-numeric entry: `r.key` over numbers made every distance NaN, so chunks load empty and unload forever, silently. Witness ring changes on BOTH GPUs (`vegTotal > 0`, `vegDraws > 0`, `grassTotal > 0`) after `npm run build:client`.
- `scripts/veg-instance-browser-witness.mjs` (both GPU arms via `SPOINT_GPU_WITNESS=amd,nvidia`) must walk the player until instancers report instances before measuring. Outputs: `mem-3e9a7f5c2b4d1068-4537`.
- Legacy mixes the raw interpolated vertex normal (`terrain.glsl:781`) while TSL normalized it first (`terrain-material-tsl.js:163`); default `reliefShade` 6 amplifies it into the 3.11 / 5.67 left-edge delta.
- Every discard in `terrain.glsl`'s FS must stay inside `#ifdef _WATERPASS_`: `gl-render` compiles the source twice, and a discard anywhere disables early-Z depth write for all its draws.
- Depth contract: mapspinner re-encodes terrain/water depth to `window.__hostNearFar` (`passPlanetDepthWriteback`; WebGPU `DepthWriteback`).
- Rendered sea = sphere R (== `PlanetFrame.waterlineLocalY`, exact to 1 cm) + waves that must be ZERO-MEAN about it.
- `display-referred-tsl.js invertAcesFilmic` must NOT end in `max(x, 0)`: a saturated blue inverts out of AP1/ACES gamut, and clamping makes the re-encode 82.7 vs 55.9.
- `ShadowPipeline.js forceUpdate` must set EVERY cascade `light.shadow.needsUpdate` (three gates per light); `cascadeCount` clamps to 1 when `sun.castShadow===false` — cascade 0 IS the sun, never renders.
- `QualityPresets.js` ships `ssao:false`/`bloom:false`; `?debugpanel=1` keeps knobs live.
- `terrain.glsl` is the single source of truth for CPU/GPU height parity (`gen-height.mjs` transpiles it into height-gen.js/height-cpu.js); deleting it needs a new source of truth + a TSL/WGSL->JS generator.

## Client and app runtime

- HUD `applyDiff(uiRoot, hudVdom)` replaces uiRoot's children every frame, so imperative DOM overlays (lobby, EmoteWheel, PauseMenu, SettingsMenu, MinimapHUD) mount on `document.body`.
- Scenery: `_buildWorldScenery` is a joinable wrapper; boot adopts the running build (`Promise.race` does not cancel the loser). The adopt branch must not be gated on `window.__terrain`.
- `app.js animate()` returns early while `window.__warmupInFlight`; two interleaved `renderer.render` passes on one GL context let `ClusterLodMesh onBeforeRender` rewrite shared geometry.groups/index mid-pass.
- Hot reload releases a ctx via `AppRuntime._releaseAppContext`; `update()` keeps running with a torn-down ctx unless `_updateList`/`_rebuildCollisionList` are rebuilt.
- `AppRuntime._attachApp` does `apps.set` BEFORE awaiting `setup()`; `spawnEntity` attaches apps fire-and-forget, so collect tagged entities on the first `update()` tick.
- Spawn: `holdSpawnUntilGrounded` (`src/sdk/Relocation.js:71`) gates release on `terrainFieldMissingAt`/`coversPosition` (max `SPAWN_HOLD_MAX_MS=20000`).
- `BrowserServer.js`: `_lastTodSync` and `_deliveredWorldFingerprints` are MODULE level: stall recovery and HostMigration rebuild a fresh BrowserServer in the same page.
- Singleplayer worker world identity comes from `INIT.worldName`; the snapshot is one IDB key `world-snapshot` per origin, so switching worlds discards by mismatch (`7d29891a8e`).
- Vegetation `InstancedMesh2`: `sortObjects` must stay false with LODs; `CullFreeze.js setInstancedCullAuto` sets `autoUpdate` on parent AND every LOD level.
- `FloatingOrigin.js update()` must `camera.position.set(0,0,0)` on rebase, not `+= -delta`: `app.js` rewrites `camera.position` from authoritative coords every frame before `update()`.
- `EntityLoader.js _primGeoKey` must use the same ||-defaults as `EntityLoaderMeshBuild MESH_BUILDERS` (capsule r0.3/h1.8).

## Measurement and witnessing

- Every GPU arm pins the adapter it names: `vendorGpuArgs(vendor)` adds `--use-adapter-luid=0,<luid>` (nvidia 1503521746, amd 62340); a vendor with no adapter exits 2, and no Intel adapter exists here. Pinning is necessary but NOT sufficient: Chrome ignores a LUID it cannot resolve and falls back to the default adapter while still reporting accelerated, so `requireAccelerated` alone never catches a mis-selected vendor — assert the renderer string too (`assertGpu`/`witnessGpu`), and `verifyVendorLuid(vendor, luids)` proves which LUID is live by launching. The unpinned default is not stable within a day (AMD in the afternoon, NVIDIA at 09:54). Details: `mem-0b6d4c2f9e1a8735-1204`.
- Witnesses can launch Chromium on SwiftShader silently: `gpu-probe.mjs assertGpu` after navigation asserts the REQUESTED adapter. AMD LUID is per-boot (`adapterLuidFor('amd')`; `perf-run` exits 2 with no AMD entry) and an unresolvable `--use-adapter-luid` silently runs the DEFAULT adapter (AMD here), never the vendor asked for. On the AMD iGPU tps-game loses its GPU context during boot, after which Chrome refuses every later context on it — race `page.evaluate` against a timeout (`evaluateOrThrow`). Numbers: `mem-0b6d4c2f9e1a8735-1204`.
- three 0.185.1 WebGPU `Info`: `info.render.calls` is CUMULATIVE and the only reliable liveness signal; `info.render.drawCalls`/`.triangles` read 0 there and there is no `info.render.frame`. Per-frame numbers come from the fields `Info.reset()` zeroes.
- A vsync-locked p50 is a refresh divisor, not work; `frame-time-gate.mjs` unlocks rAF. Baselines are PER-VENDOR (`.frame-time-baseline.<vendor>.json`; `frame-time-baseline.mjs` refuses another adapter's); AMD has none, so the gate fails loudly. The orbit arm is a +-0.25 rad sine sweep, NOT a 360 deg spin, and must render >= 50% of the static arm's triangles; the WebGPU triangle exemption and its camera pose are in `mem-0b6d4c2f9e1a8735-1204`.
- A ms-per-tick counter is not a measurement (`_lastCollisionMs` moved 0.310 -> 0.423 while work-unit counters moved under 1%)
- `scripts/prediction-drift-witness.mjs` is the diagnostic for "the client led the server": it caps peak unacked (24) and peak divergence (3 m) and requires the last 5 divergence samples under `--settle-tol` (0.5 m). `--server-tick=<hz>` is the only lever that reaches those caps (it slows the tick loop while the handshake keeps advertising the world's rate); against it `MAX_PREDICTION_LEAD_STEPS` 16 pins unacked at 13-16, where an unbounded lead reaches 127-152 and 17.3 m and the server applies 0.516 of the movement instead of 0.986. Numbers: `mem-2d8f6e4b1a3c0957-3426`.
- A wall-clock ms/s gate measures the box; a counter never incremented is a silent pass. Decide perf rows on counted work units.
- Draw counts: authoritative = `perf-run.mjs drawsInstrument.authoritativeField` (`wgpuDrawsPerFrame`/`glDrawCallsPerFrame`) = 141, the per-frame DELTA of `info.render.drawCalls` since `8f5214d164`.
- CDP `Input.dispatchKeyEvent` in `perf-run.mjs` reaches Chrome but never sets the app's input bucket; `nav->inputAccepted` is not an input-acceptance metric. A walk witness must measure accumulated path length (sum of sampled position deltas), never net displacement.
- TSL-vs-legacy parity criterion (written BEFORE any frame): a region matches iff cross-renderer meanAbs/channel <= 3 x max(same-renderer noise floor, `QUANT_FLOOR` 1.0); floors differing >3x = INDETERMINATE.
- gm `exec_js` dispatches are ephemeral, isolated worker contexts (a server booted in one is gone by the next); detached+unref spawn dies too (Windows Job Object). Screenshot trap: `TerrainBackdrop.renderPlanet` rebuilds eye/target from `camera.getWorldDirection()`, broken for a posed camera. Pre-change control: gm `git_show {path, rev:"HEAD"}`, write to `scripts/.<name>.mjs` so `./lib/...` resolves, run, delete.
- Environment: `localhost` resolves ~200 ms vs `127.0.0.1` 5 ms — use the literal IP. Snapshot bundles with `cp -p`, never `cp`; compare two harness reports only on the same code.

## Security

- HiddenSpawn second-stage loader found and cleaned 2026-09-29 (`70cfe04f`): a `.env` plus 16 lines in `src/fluid/as-src/sph.ts`.
- `SESEvaluator` fails closed with no proxy tier; `StaticHandler` enforces path containment and COEP `require-corp`; `server-http-auth-matrix` holds the route/auth table.
- `SESCompartmentEvaluator.js` is the only untrusted-app evaluator; a failed `import('ses')`/lockdown throws `SandboxUnavailableError` (SANDBOX_UNAVAILABLE); first-party `apps/` never touch it.
- `authCompare.js timingSafeTokenEqual` self-compares (`bufA,bufA`) on a length mismatch so token length is not leaked — do not simplify it away.
- Benign exec surfaces, never flag as malware: `lang/spoint.js` (gm exec plugin), `mapspinner/planet.html` pollCmd eval, `scaffold.js` npx, `cdp-browser.mjs` curl relay.

@.gm/next-step.md
