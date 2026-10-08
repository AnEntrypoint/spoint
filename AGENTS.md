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

One line per fact; numbers/scenarios/derivations in memo tier: `mem-0b6d4c2f9e1a8735-1204` measurement/GPU · `mem-1c7e5d3a0f2b9846-2315` physics/terrain · `mem-2d8f6e4b1a3c0957-3426` netcode · `mem-3e9a7f5c2b4d1068-4537` rendering · `mem-4f0b8a6d3c5e2179-5648` fire/cluster/chart · `mem-a6f1d7bd7be3412c-3784` live-GL · `mem-e44338278288dcd3-1912` AMD box contention.

## Working rules

- Commit as lanmower, main-only, `git_commit` explicit `paths` (`0292ad7b`); pathless `git_finalize` sweeps another lane's edit (`830db61a`, `src/terrain/ColliderStreamer.js:435`). Co-author trailers one-way; no workflow in this tree strips them (the `auto-declaudeify` workflow lives only in other refs' history, not on main).
- `git_commit` fails while `.git/index.lock` exists; foreign stalled git holds it 20+ min — confirm via `Get-CimInstance Win32_Process` cmdlines; 0-byte lock + no spoint git alive = removable.
- Generated artifacts ship with source: `AppContext.js` -> `sdk-typings.generated.d.ts`; height-code change re-bakes `apps/world/*.hf`.
- `BAKE_TRANSFORMS` entry = narrowest module transform reads + what that path reads, not import closure; mutation proves it. `SNAPSHOT_ENCODE`: entries `[EcsEntityMap.js]`, inputs `AppRuntime.js`+`EcsEntityMap.js` (`d6e2eb93`).
- `check-cache-keys.mjs` shared: edit in another transform's `BAKE_INPUTS_*` reddens `npm run check` every lane till `src/shared/cacheCodeVersions.js` pin bumps in same commit. `check.mjs` parses TRACKED files only: uncommitted deletion of tracked probe fails its parse arm every lane.
- `core.autocrlf=true`; `w/crlf` in `git ls-files --eol` is no diff. `git_diff` ignores autocrlf, so a disk/blob ending mismatch reads as whole-file rewrite — convert to the blob ending first; endings are per-file inconsistent (`bundle-client.mjs` LF, `src/sdk/ServerBoot.js` CRLF).
- `.gitignore` exempts only `.gm/disciplines/project/` from `.gm/*`: memo outside silently uncommittable (`git_commit` succeeds, `git_show --name-only` omits it).
- Untracking needs gm `git_rm {"cached":true}` + paths-scoped `git_commit` (`index_commit:true`) with byte-identical `git ls-files` paths; any other spelling re-adds and destroys the deletion. Verify via `git ls-files`; `git_rm` has no containment guard, so `paths:["."]` untracks the whole index.
- `@spoint/ecs` only `@spoint/*` specifier; link vanishes mid-session, kills every harness — `npm run links` restores, never `npm install`.
- `scripts/gpulock.mjs run <owner> [--wait-ms N] [--ttl-ms N] -- <node> <script>` (`bash` child exits 127) serializes accelerated arms via `.gpu-lock/owner.json`: heartbeat + pid liveness, takeover past `--ttl-ms`, named refusal past `--wait-ms`; `status`/`release` inspect (`held:false, stale:true` = free); propagates child exit code. Serializes ADAPTER only, never CPU.
- Never `git worktree remove` a `scripts/worktree-setup.mjs` worktree (node_modules junction deletes `node_modules/.bin`); use `scripts/worktree-teardown.mjs`.
- gm spool: `in/<verb>/<session_id>-<random8>.txt`; write sibling `.tmp`, RENAME onto `.txt` (straight write dispatches a torn body, "query required"); never reuse a suffix. codesearch reads the WORKING tree. Comment sweep: gm `codesearch` `{"comments_only":true,"no_ignore":true}`; `refresh` REJECTED; `glob` matches FILENAMES.
- CI: completing jobs are `check` (`ubuntu-latest`, `npm ci`+`npm test`) and `frame-time-coverage`, whose title states whether the accelerated arms ran — `frame-time` carries `if: vars.CI_GPU_RUNNER_ONLINE == 'true'`, so with no runner and the var unset it reads SKIPPED, never `queued`; enabling it takes both a registered runner and the var. `concurrency` group PER SHA (`ci-${{ github.ref }}-${{ github.sha }}`); per-ref group cancels older pending runs even with `cancel-in-progress:false`. CI Node 20 vs box Node 24 (`process.threadCpuUsage` at `76059b48`, `cpuSample` falls back `process.cpuUsage`); fatal path kills forked clients or stdout pipe holds `check.mjs` to its 600 s cap.
- Witnesses run POSIX too: Windows-absolute path to `fetch`/`new URL` throws `Failed to parse URL from /home/runner/...` on Linux CI; box-collider fallback hides it (`fire-tps-game-witness.mjs`).
- `npm run check` (gpu-free arm -> `fire-witness-gate.mjs` -> `check-frame-time-baselines` -> opt-in `SPOINT_GPU_WITNESS` veg arm) parses only tracked `src,client,apps,scripts,bin`, refuses browser/GPU witnesses by name; witness exits 0 AND prints `RESULT: PASS`.

## Repo boundaries

- `design` ships as pinned CDN URLs in `client/{index,landing/index,editor/thebird-host}.html` + `scripts/bundle-client.mjs` (`anentrypoint-design` -> unpkg `1.0.34/dist/247420.{js,css}`). `vendor/*` editing-only submodules (edit on own `main`, push, then commit gitlink); all UI built in `AnEntrypoint/design`.
- `apps/*` never imports `client/*` (singleplayer Worker resolves relative specifiers vs virtual root); expose utilities on `engineCtx` (`engine.THREE`, `ctx.kit`).
- Keep Node-only dynamic import specifiers opaque to esbuild/wrangler: build in IIFE, `(() => './' + 'ServerAPI' + '.js')()`. `edge/cf-do/spoint-do.js` imports `jolt-edge-init.js` BEFORE `WorkerEntry.js` (`globalThis.__SPOINT_EDGE_BUNDLED__` set at its top level).

## Debugging discipline

- Bug surviving threshold change was not fixed; re-diagnose. Fix failing end-to-end at its own layer = second copy of same check (`ShapeBuilder.js`, `cluster-lod-mesh.js`).
- `src\win\async.c:76` = libuv `uv_async_send` assert: fires at `process.exit()` with handles mid-close, so headless scripts await `process._getActiveHandles()` hitting 0 (arms add unref 2 s `exitAfterQuiesce` hard exit).
- Witness needing server to act on client message passes `--params=multiplayer`; `?singleplayer` sees `players:0`, acks `ok:false`. `net::ERR_ABORTED` = cancellation; only real failure or HTTP >= 400 fails arm. Harness returning uncompared `{expected, got}` passes either way: one `expect()` per measurement, non-zero exit.
- `window.__spoint._drive` = `Relocation.js drive()`; wrap it to OBSERVE input.
- One `gl.getError()` code covers distinct bugs (1282 = feedback-loop, sampler-type-mismatch AND insufficient-buffer-size): read driver's own console string off cache-disabled reload.
- Node deprecation warnings (DEP0152 + siblings) reach `console.error` via warning handler: bucket leading `(node:PID) [DEPnnnn]` separately (`planet-multiplayer-harness.mjs` counts `nodeDeprecations`).
- Troubleshooting (`scripts/lib/`): `head-vs-worktree.mjs <paths>`, `agent-report.mjs <task-id> [--blocks N] [--chars N]`, `gm-dispatch.mjs <verb> [body] [--timeout-ms N]` when MCP detached, `witness-audit.mjs`, `ci-verdict.mjs <sha|short>` (0 green / 1 red / 2 none / 3 pending), `ci-logs.mjs <sha> [--tail=N] [--match=re]` (`--commit` needs full sha; short resolves via `git rev-parse`). Full disk fails every verb — reclaim stale `.gm/browser-chrome-profile-*` (~0.13 GB/session, no retention) first.
- `witness-audit.mjs --gate` = gpu-free arm of `npm run check`: per-file per-check counts vs committed `.witness-audit-baseline.json`; fails on absent check id or count above it, so a witness that cannot fail cannot land. `--write-baseline` re-records; dropped count prints stale-baseline, no fail — baseline is a floor to ratchet down; `--gate` reads HEAD blobs (`--worktree` opts out). `ws-polyfill-missing` = Node witness hitting `ws://` with no `globalThis.WebSocket`.

## Entry points

- `ctx.defineGameFSM(spec)` `src/behaviours/game-fsm.js`; `ClientMachine.js` xstate5 parallel, fallback `after:` 10 s gated / 45 s hard stop; editor REPARENT/DUPLICATE/SET_LABEL = 0x94-0x96.
- `ctx.defineFire(spec)` `src/behaviours/fire.js` (wired at `AppContext.js:387`, default off); design recall slug `project/fire-system-design-2026-10-05`.
- Test relocation: `window.__spoint` + `MSG.TELEPORT` (0xc2 / ACK 0xc3, `src/sdk/Relocation.js`; no `EDITOR_TOKEN` = any client, `relocation:false` disables, >87 deg refuses).
- Client app's `ctx.state` = entity `custom` block (`AppModuleSystem.js:82`), not server app state (`AppRuntime.js:686`): `ctx.state.<key> ?? literal` takes literal forever. `engine.cam` = camera CONTROLLER, no `position` — read `engine.client.getLocalState().position`.
- Wireweave attach helpers run after awaits (host migration reassigns `client` at `app.js:2666`): re-check at call time (`d6cf7bc7`).
- `createServer()` = per-call factory; `getJolt()` WASM + `boot()` SIGINT/SIGTERM handlers process-global: stop with `RoomDirectory.stopAll`.
- Remote server's `netcode.profile` named only when client = real `PhysicsNetworkClient`: boot that witness on `?connect=...&multiplayer=1`, else falls back to in-page `BrowserServer` (`51fff55f`).

## Fire

- Integer-only kernel `fireKernel.js`: decisions from `hash(seed, step, face, I, J)`, no float / `Math.random` / `Date.now`. Cells = 2x2 veg placement cells (8 m); step boundaries absolute ticks.
- Rain smothers, does not eat fuel: rain-suppressed cell still burns `burnRate`, pushes no heat, spots nothing (`fireKernel.js burnCell`). `rainPerIntensity` (255, `fireSpec.js:148`) maps intensity 0..1 to roll byte, scaling with step length; per-world `weather` block pins it.
- `ctx.navCostAt(x,z)` = 8 burning / 2 charred; `canSee` smoke-gated via `_fireNavByRuntime` at depth >= `smokeBlockDepth`.
- Wind = weather vector (BASE) + `hash(seed, step)` gust (`fireWind.js`), clamped +-16 per axis; `snapshot().wind` carries BASE only.
- Per-cell initial fuel not recomputable in kernel (`classify()`, `VegPlacement.js:170-234`); any per-tile array added to `snapshot()`/`restore()` joins `TILE_ARRAYS` (`fireKeyframe.js`) + VERSION bump (now 6).
- Tampered keyframe rejected at DECODE, named `[fireKeyframe]` error. `G` = ignition step mod 256, not age; IGNITE_AREA kind 5, radius <= 8 cells.
- A boundary snapshot's `delta` rolls back the step BEFORE it (`takeDelta` at t=K reads `preStep` captured at K-`stepTicks`), so a restore verifies against the boundary's `counters`, never its `delta`. `adopt`/`rewindTo`/`submit` return `{ok, reason, detail}`; `adopt` refuses a snapshot failing `validateFireSnapshot`.

## Planet-wide multiplayer (`src/shared/clusterAssignment.js`)

- One server world per cluster, each own flat chart. Jolt heap fixed 134217728 B, never grows; over it `new J.JoltInterface` raises `Aborted(OOM)` (`src/physics/World.js:60`).
- Three limits, not one cap: `maxContactConstraints` under requirement drops contacts silently; `maxBodies` under population makes Jolt return body id 0, so overflow bodies share one map key, `destroy()` aborts wasm.
- Assignment pure, hysteretic, antipodal-safe, 2-4 Hz; `resolveClusterConfig` refuses link below relevance ring or longest weapon range.
- Collider rings (`ColliderStreamer.js`): `DEFAULT_MAX_CENTERS = 192` BOTH trunk + rock streamers (`1d8358bf`); rings per connected player, never centroid. `classifyRings` per-cluster quota resets every pass, first-fill, no guarantee; `evictOverCap` farthest-first; boot ring placement-generation-bound vs `COMPUTE_BUDGET_MS` 2.5 ms.

## Chart re-anchor

- Chart-local server holders migrate via `src/sdk/chartState/` (`attachServerChartMigrators(ctx, service)`; default off). Re-anchor = change of basis, not rotation: position, velocity, forward invariant. CHART_REANCHOR = 0xc6; epoch u32 rides snapshot header + input/fire/teleport messages.
- Flat chart's intrinsic tilt fixed by shrinking chart: `CHART_ANCHORS_PER_FACE = 32` (`chartAnchor.js`, `b6af3ff0`). `CHART_REANCHOR_ANGLE_DEG` (28 / 14) must exceed worst angle of its `createChartAnchorLattice` or anchor thrashes.
- Exactly ONE chart per world (`setupTerrainStreaming` calls `createPlanetFrame` once), so two players at separation Delta sit at Delta/2, walkable iff `terrainTilt + Delta/2 <= 45 deg`.
- `ChartReanchorTerrain.js`: HeightfieldStreamer fields REBUILT off-path in slices, then installed; ColliderStreamer rings transform in place via `setBodyTransform`.

## Physics and Jolt

- `physics.setBodyMotionType` returns NEW body id or `false`; recreation creates new body BEFORE destroying old, on `LAYER_DYNAMIC`, refusing body holding constraint, vehicle chassis or trimesh/mesh/heightfield shape.
- Pooled body whose `bodyMeta.type` differs from requested motionType is destroyed + replaced (`scaledShapeKey()` encodes model|scale only); matching slot revives via `_revivePooledBody`; `removeBody` on pooled DYNAMIC body does `DeactivateBody`, zeroes both velocities.
- `BodyInterface.GetPosition` returns ONE shared temp, so two calls alias: `addConstraint` reads default anchors via `getBodyPosition`. Forced `removeBody(id, true)` destroys body; cached shape dies with LAST body using it.
- Jolt recycles removed bodies' tree nodes only in `physics.step`: re-adding thousands of bodies with no step between aborts wasm.
- Jolt `HeightFieldShape` exposes `GetMinHeightValue()`/`GetMaxHeightValue()`/`GetSampleCount()`, NOT `get_mMinHeightValue`/`get_mHeightQuantizationScale`; `GetSampleCount()` = PER-SIDE count (N), not N*N (`terrain-residency-seam-witness.mjs`).
- `GLBLoader` discriminates by URL SCHEME (`^([A-Za-z][A-Za-z0-9+\-.]+):`, >=2 chars so Windows `C:` drive reads as none): scheme-less path from disk, `file:` decoded via `fileURLToPath`, else fetched.
- Trimesh/convex collider build failure in `src/apps/AppPhysics.js` PROPAGATES as `ColliderBuildError`, never degrades to 0.5 m box; `AppRuntime` `config.autoTrimesh` branch + `EditorHandlers.js` still box, separate rows.
- `AppRuntimePhysics.js` skips `e._vehicleId != null` in BOTH `_tickPhysicsLOD` + `_enforceBodyBudget`. `HeightFieldShape` quantizes over own min/max. Height samples snap to 1 mm via deliberate `+ 0`: `Math.round` of sample in (-0.5 mm, 0) yields -0; -0/+0 differ as `Float32Array` bits.
- `VehiclePhysics.js`: never `J.destroy` `v.constraint`/`v.tester` after `RemoveConstraint`, never destroy `get_mTracks()` copies after `set_mTracks`; empty `mDifferentials` = zero wheel torque. `apps/_lib/softbody.js`: EVERY particle body needs massed collider, pinned or not; each cloth owns own `RAPIER.World`.
- EDITOR_UPDATE calls `syncEntityCollider` AFTER `changeBodyType` (which removes body, synthesizes default box `_bodyDef`, clobbering `custom._collider`). `StaticTileIndex.update` tiles static non-sensor bodies at 16 m XZ off a 16-value `Float64Array` bounds record.

## Terrain and colliders

- `solveSurfaceY` tolerance absolute `1e-4` (`SURFACE_SOLVE_TOLERANCE_M`, `PlanetFrame.js:3`), 64-eval cap, throws `SurfaceSolveError`; past 63.6 km returns `-(R+anchorHeight)`, NO throw.
- Baked heightfield FAIL-LOUD (`896f3351`, `src/terrain/TerrainPhysics.js`): absent falls back to CPU silently; unreadable/truncated/bad-magic/stale-code-version throw a named `[baked-heightfield]` error naming file, expected, actual. `hashVersion`/`terrainKey`/`chartEpoch` mismatch warns and falls back: different terrain, not damage.
- No terrain FATAL: `ServerAPI.loadWorld` rethrows `[terrain] world "<id>" has no terrain`; every caller stops server it created first.
- Two height backends; `gpu-eval.mjs` exposes `__sampleHeights(dirs)`. v2 = parity backend; carves (`terrainCarvesOf`) v2-only. On hashVersion 1 boot frame ground = GPU patch collider while `frame.elevationAtDir` still CPU sampler.
- `elevationAtLocal(frame,x,y,z)` exactly `|p|-radius`; app-facing `ctx.terrainHeightAt` NOT that. v1 CPU consumers: `MinimapBiome.js`, `relocation.js`, `PlacementChart.js`.
- `PlanetFrame.groundHeightLocal` memoises 4096 direct-mapped slots keyed by EXACT `(x,z)` + chartEpoch, caching `SurfaceSolveError` too.
- `terrain.glsl` `snoise3`/`vnoise2`/`seaHash`/`hpfSample` take in-cell fraction as `P-floor(P)` from ONE `floor`. Cube-face frame duplicated across `faceFrame()`/`hpfFaceUV()`/`faceWarp`, `gl-render.js _faceFrames`, `FACE_FRAME` in `planet-orchestrator-cull.js`/`patch-baker.js`/`anchor-field-bands.js`.
- Server terrain collider lives in ONE fixed-anchor local tangent plane (`createPlanetFrame`, `anchorDir` default [0,1,0], never re-anchored): cannot represent directions past ~87 deg from anchor.
- `gl-render.js sampleGroundM` fire-and-forget async (PBO+fence): each call returns PREVIOUS call's harvested height; non-rAF callers use `sampleGroundMSync`, which poisons next async collision read.
- `VegPlacement.js`/`RockPlacement.js` read climate before `surfaceOfCell` only when `climateUsesLocalXZ !== true`. Veg density must gate on painted snow, else surviving grass weight roots trees.
- REFUTED, do not retry blind: 2-tap forward difference in `src/terrain/PlacementChart.js radialSlopeAt` — gradient crosses `SLOPE_MAX` 0.6, flipping gate decisions. Candidate holds `c2ab90c4`/`319ecc02`/`f69a904a` over 120-chunk sweep.

## Netcode and wire

- Prediction runs no collision: `PredictionEngine.js:325` gates the resim on `horizontallyWedged`, latched by a no-plane stall or a stop while commanding. Replay/lockstep drift comes from dt.
- `msgpack.js` `WIRE_STRUCTURES[1]` lists exactly keys, in order, of `TickHandler.js _packPayload` (seq,tick,serverTime,players,entities,removed,delta,dots). msgpackr 2.0.4 writes -0 as `0x00`; `patch-deps.mjs` excludes -0 from both integer tests.
- `PhysicsNetworkClient.connect()` REJECTS, named `TransportConnectError` (`err.reason`: `websocket-unavailable`|`websocket-error`|`websocket-closed-before-open`|`connect-superseded`), not `connected:false` + no socket; retry belongs in caller (`_doReconnect`), never in fake success.
- Wire v3 player record: 8 fields in 22-byte bin; recipient-only `[inputSequence, inputBuffer, groundNormal]` ride per-recipient `me` block, so snapshots pack per recipient. `getSnapshot()` keys on `_version === _snapshotVersion` alone (tick gone).
- `SnapshotGroupPlanner`: groups = `ceil(viewers*perViewerMs/(budgetMs-fixedMs))`, budget = tick period * `SNAP_COST_HIGH_FRAC` 0.35 (`TickHandler.js:30`). Interest management off by default: `relevanceRadius || 0` (`server.js:67`) returns every player; no world sets it.
- Lockstep: rollback input-capped, so measure by depth, not rate (`maxRollbackTicks` 12); `inputDelayTicks` above `INPUT_RETAIN_TICKS` (240) throws at construction. Any new per-tick gameplay timer in `AppRuntime` tick-indexed, never `Date.now()`.
- Socket becomes player by MIGRATE, RECONNECT, or silence past the MIGRATE-peek grace (`ServerHandlers.js onClientConnect`, 50 ms / 1500 ms dilated) — silent probe joins as phantom, so probes use `?probe=1`. Never answer unresolvable RECONNECT with INVALID_SESSION and leave it open: `rejectSession` flushes and closes; refused MIGRATE closes the candidate.
- Migration keeps old transport as fallback owner, hands player back on candidate death; close from transport client no longer owns cannot tear it down (`transport-churn-witness.mjs`).
- Authoritative path: prediction off by default (`?predict` only); rollback/lockstep unwired. `TickHandler.js processPlayerMovement` takes ONE input per tick, catching up only while `inputs.length > INPUT_BUFFER_CATCHUP_DEPTH` 8, `extra < MAX_CATCHUP_STEPS_PER_TICK` 3, `player.inputStepBudget >= 1`; `INPUT_STEP_BANK` 16 bank all that stops 4x-real-time movement.
- `BaseClient.js sendInput` stops feeding `predEngine.addInput` once `predictionLeadSteps()` reaches `MAX_PREDICTION_LEAD_STEPS` 16, so fast client degrades to bounded lead.

## Rendering

- `WebGPURenderer` DEFAULT (`?legacygl=1` opts out); unavailable WebGPU retries with `forceWebGL=true` before legacy, so TSL only shader path. WebGPU consumes TerrainBackdrop's `fE` DIRECTLY as per-vertex clip transform; WebGL uses `fE` only for CPU frustum culling.
- `three.webgpu.js` (pinned 0.185.1) drops a pending `popErrorScope()` rejection unhandled at 3 sites; `patch-deps.mjs` patches all three; `MapspinnerPipelineCache.getPipeline()` error-scopes `createRenderPipeline`.
- `patch-grid-render.js _ensureInstanceBuffer` must NOT reference-equality-guard reused array. `ClusterLodMesh._render` fires once PER GROUP per frame: keep `_lastRenderFrame===frame` early-return.
- `webgpu-hiz-shaders.js` compute cull stays algebraically equal to CPU paths (`isOccludedBox` `minZ >= texel + 1e-5`). Vegetation LOD classifies whole cells on uniform grid (`MAX_CELLS`, `GRID_MIN_OCCUPANCY`); `veg-instance-browser-witness.mjs` walks player until instancers report instances before measuring.
- Veg-LOD oracle for `WebGPULodInstancer` mirrors two `updateLOD` rules: `lodEye` refreshes only after camera moves `LOD_REEVAL_MOVE_SQ` (0.5 m) since last refresh; `addInstances`/`removeInstances` set `lodStale = true`.
- A species' leaf instancer is a SATELLITE of its branch (`opts.host`, `fd942a27`): no own grid, `updateLOD` returns immediately, tier/shadow/visibility mirrored from host, so one uniform-grid walk per species not two. Mutating one side of a pair alone throws or diverges.
- `client/core/PlacementRing.js keysAround` returns `PlacementLattice.ringAroundDir` numeric chunk keys UNCHANGED (`90c2bcad`), throws on a non-numeric entry. Witness ring changes on BOTH GPUs (`vegTotal`, `vegDraws`, `grassTotal` > 0) after `npm run build:client`; serves `dist/client/app.js`.
- Every discard in `terrain.glsl` FS stays inside `#ifdef _WATERPASS_` (discard anywhere disables early-Z depth write for all its draws). It = SoT for CPU/GPU height parity (`gen-height.mjs` transpiles it); deleting it needs new SoT + TSL/WGSL->JS generator.
- `invertAcesFilmic` must NOT end in `max(x, 0)`: saturated blue inverts out of AP1/ACES gamut. `ShadowPipeline.js forceUpdate` sets EVERY cascade `light.shadow.needsUpdate`; `cascadeCount` clamps to 1 when `sun.castShadow===false` (cascade 0 IS sun, never renders). `QualityPresets.js` ships `ssao:false`/`bloom:false`.
- Vegetation `InstancedMesh2`: `sortObjects` stays false with LODs; `CullFreeze.js setInstancedCullAuto` sets `autoUpdate` on parent AND every LOD level. Hand-written `ShaderMaterial` reaching grass/veg includes `<instanced_pars_vertex>`; `model-pool.js` drains allow >=1 unit/frame or zero budget deadlocks.
- Wall-clock budget buys WAITING, not work. `Vegetation.prewarm` budgets placement WORK, slices at `PREWARM_SLICE_MS` 24, yields on macrotask, `minChunks` = floor not cap. `Rocks.prewarm` needs same slices.

## Client and app runtime

- HUD `applyDiff(uiRoot, hudVdom)` replaces uiRoot children every frame, so imperative DOM overlays (lobby, EmoteWheel, PauseMenu, SettingsMenu, MinimapHUD) mount on `document.body`.
- `_buildWorldScenery` joinable wrapper; boot adopts running build (`Promise.race` does not cancel loser); adopt branch not gated on `window.__terrain`.
- `app.js animate()` returns early while `window.__warmupInFlight`; model-pool + streaming loads pump from the frame jobs there, so never park a wait inside warmup. Two interleaved `renderer.render` passes on one GL context let `ClusterLodMesh onBeforeRender` rewrite shared geometry.groups/index mid-pass.
- Client `WORLD_DEF` from `sendWorldDefAndModules` has `entities` STRIPPED, carries `_modelUrls`: derive world-entity facts from `_modelUrls`.
- Hot reload releases ctx via `AppRuntime._releaseAppContext`; `update()` keeps running with torn-down ctx unless `_updateList`/`_rebuildCollisionList` rebuilt.
- `AppRuntime._attachApp` does `apps.set` BEFORE awaiting `setup()`; `spawnEntity` attaches apps fire-and-forget, so collect tagged entities on first `update()` tick.
- Spawn: `holdSpawnUntilGrounded` (`src/sdk/Relocation.js:71`) gates release on `terrainFieldMissingAt`/`coversPosition` (max `SPAWN_HOLD_MAX_MS=20000`).
- Respawn clearance shared: `src/apps/AppGameplay.js pickSpawnPoint` and tps-game use one `footprintBlockers` sampler (17 down-ray columns; surface > `MAX_FOOTPRINT_INTRUSION_M` 0.15 m above a column bottom = `intruding`) plus 8 directions x 5 capsule heights, each requiring the radius at that rise — the old one-height sweep missed every blocker below `centerHeight` (14 of 30 intersecting points called clear, now 0; `spawn-clearance-witness.mjs` in the gpu-free arm).
- `BrowserServer.js`: `_lastTodSync` + `_deliveredWorldFingerprints` MODULE level — stall recovery + HostMigration rebuild fresh BrowserServer in same page.
- Singleplayer worker world identity from `INIT.worldName`; snapshot = one IDB key `world-snapshot` per origin, so switching worlds discards by mismatch (`7d29891a8e`).
- `FloatingOrigin.js update()` does `camera.position.set(0,0,0)` on rebase, not `+= -delta` — `app.js` rewrites it each frame. `EntityLoader.js _primGeoKey` uses same ||-defaults as `MESH_BUILDERS` (capsule r0.3/h1.8).

## Measurement and witnessing

- Every named GPU arm pins adapter it names: `vendorGpuArgs(vendor)` adds `--use-adapter-luid=0,<luid>`; `gpu-probe.mjs gpuLaunchArgs()` does NOT route LUID. Pinning necessary, NOT sufficient — Chrome ignores unresolvable LUID while reporting accelerated, so assert renderer string (`assertGpu`/`witnessGpu`). AMD LUID per-boot (`adapterLuidFor('amd')` reads DirectX registry).
- REFUTED (`7c968d0a`): AMD iGPU does not lose GPU context at tps-game boot; the hang was `probeGpu()` minting a fresh WebGL2 context in the page measured, so `probeGpu` reads `window.__rendererInfo`. Never mint a context in a page you measure; race `page.evaluate` vs timeout (`evaluateOrThrow`).
- Software rasterizer cannot reach gate floor, so frame-time arm needs accelerated runner. Floors: `VEGETATION_FLOOR` 1000, `MIN_SAMPLES_FOR_ONE_PERCENT_LOW` 200.
- Vsync-locked p50 = refresh divisor, not work; `frame-time-gate.mjs` unlocks rAF. Baselines PER-VENDOR (another adapter's refused; an unbaselined vendor fails loudly): AMD 18.39 ms at `ee756369`, NVIDIA 9.03 ms at `76059b48`, 5207 veg both. Orbit arm = +-0.25 rad sine sweep, renders >= 50% of static arm's triangles.
- Contention gate needs a GPU-bound control page (1280x720, two full-screen 3072-iteration fragment passes, 1 `readPixels`/frame): refused on no cadence, floor unreached, quantum at 1.5x own p50, before/after >1.25x; probes calibrate (30 ms target, 20 ms floor), compare per-1000-iteration cost; verify >1.25x recorded cost refused; no capture writes a slower baseline (`--accept-slower=<reason>`).
- AMD frame-time verdict needs quiet window: `gpulock` serializes adapter, not CPU, so a verify FAIL naming CPU contested = shared box. Settle probe under 40 frames/2000 ms = busy box.
- WebGPU `Info`: `info.render.calls` CUMULATIVE, only reliable liveness signal (`drawCalls`/`.triangles` read 0, no `info.render.frame`). TSL-vs-legacy parity written BEFORE any frame: region matches iff cross-renderer meanAbs/channel <= 3 x max(same-renderer noise floor, `QUANT_FLOOR` 1.0).
- Decide perf rows on counted work units: ms-per-tick counter is no measurement, never-incremented counter a silent pass — confirm the field exists on the measured backend (`vegProfile.meshInstances` read `LODinfo.render.count`, absent on `WebGPULodInstancer`; `ee2e3baa`). Authoritative draw count = `perf-run.mjs drawsInstrument.authoritativeField` (`wgpuDrawsPerFrame`/`glDrawCallsPerFrame`).
- `prediction-drift-witness.mjs` diagnostic for "client led server": caps peak unacked (24), peak divergence (3 m), last 5 samples under `--settle-tol` (0.5 m); `--server-tick=<hz>` only lever reaching them. Two arms alternate per rep, each axis gated vs rep-to-rep spread, so inert horizon reports "no separation gain" (`13f0a296`).
- CDP `Input.dispatchKeyEvent` reaches app input bucket — read `window.__app.sentInput`/`sentInputCount` (`32620b5b`). `perf-run` `inputReachedGame` needs held leg's movement bit + `sentInputCount` advanced (`1d34eecb`), null for a held non-movement key; keyboard sets `input.backward`, never `input.back` (`InputHandler.js:160`). Walk witness measures path length, not displacement. `[physics] peak active 0` is not a stalled player (`CharacterVirtual` never counted by `GetNumActiveBodies()`).
- gm `exec_js` dispatches ephemeral: server booted in one gone by next. Use `127.0.0.1`, not `localhost` (~200 ms); snapshot bundles with `cp -p`.
- Headless Node witness constructing `PhysicsNetworkClient` polyfills `globalThis.WebSocket` from `ws`: Node 20 has none, so every multiplayer arm fails "only 0 of 2 client(s) joined". Pre-change control: `scripts/.<name>.mjs` from gm `git_show {path, rev:"HEAD"}`.
- `edge-collider-draco-witness.mjs` rewrites tracked `apps/tps-game/*.glb` in place — never run inside gate; dirties tree it checks.

## Security

- HiddenSpawn second-stage loader cleaned (`70cfe04f`). Re-run dependency scan on any fresh or updated `node_modules`.
- `SESCompartmentEvaluator.js` only untrusted-app evaluator, fails closed, no proxy tier; `StaticHandler` enforces path containment + COEP `require-corp`; `server-http-auth-matrix` holds route/auth table. Failed `import('ses')`/lockdown throws `SandboxUnavailableError` (SANDBOX_UNAVAILABLE); first-party `apps/` never touch it.
- `authCompare.js timingSafeTokenEqual` self-compares (`bufA,bufA`) on length mismatch so token length not leaked — do not simplify away.
- Benign exec surfaces, never flag as malware: `lang/spoint.js` (gm exec plugin), `mapspinner/planet.html` pollCmd eval, `scaffold.js` npx, `cdp-browser.mjs` curl relay.

@.gm/next-step.md
