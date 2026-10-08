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

Memo tier: `mem-0b6d4c2f9e1a8735-1204` GPU · `mem-1c7e5d3a0f2b9846-2315` physics · `mem-2d8f6e4b1a3c0957-3426` netcode · `mem-3e9a7f5c2b4d1068-4537` rendering · `mem-4f0b8a6d3c5e2179-5648` fire/chart · `mem-a6f1d7bd7be3412c-3784` live-GL · `mem-e44338278288dcd3-1912` AMD contention.

## Working rules

- Commit as lanmower, main-only, `git_commit` explicit `paths`; pathless `git_finalize` sweeps another lane's edit. Push `git_push {rev:"HEAD"}` — bare `git_push {branch:...}` gate-denied while foreign dirt exists.
- `.git/index.lock` present fails `git_commit`; foreign stalled git holds it 20+ min — confirm via `Get-CimInstance Win32_Process` cmdlines; 0-byte lock + no spoint git alive = removable.
- Generated artifacts ship with source: `AppContext.js` -> `sdk-typings.generated.d.ts`; height-code change re-bakes `apps/world/*.hf`.
- `BAKE_TRANSFORMS` entry = narrowest module transform reads + what that path reads, not import closure.
- `check-cache-keys.mjs` shared: editing another transform's `BAKE_INPUTS_*` reddens `npm run check` every lane till `src/shared/cacheCodeVersions.js` pin bumps in same commit. `check.mjs` parses TRACKED files only: uncommitted deletion of tracked probe fails its parse arm every lane.
- `core.autocrlf=true`; `w/crlf` in `git ls-files --eol` = no diff. `git_diff` ignores autocrlf: disk/blob ending mismatch reads as whole-file rewrite.
- `.gitignore` re-includes `.gm/*` only under `.gm/memories/` + `.gm/disciplines/project/`; other `.gm/` paths uncommittable silently (`git_commit` succeeds, `git_show --name-only` omits them).
- Untracking: gm `git_rm {"cached":true}` + paths-scoped `git_commit` (`index_commit:true`) with byte-identical `git ls-files` paths; any other spelling re-adds. Whole-tree pathspecs refused unless `allow_whole_tree:true`. Verify via `git ls-files`, never `removed`.
- gm MCP = HTTP, not stdio (`http://127.0.0.1:8787/mcp`); Claude Code connects once, never retries; startup gap detaches session — recover via `/mcp`.
- `@spoint/ecs` resolves only via `@spoint/*`; link vanishes mid-session, kills every harness — `npm run links` restores, never `npm install`.
- `scripts/gpulock.mjs run <owner> [--wait-ms N] [--ttl-ms N] -- <node> <script>` serializes accelerated arms via `.gpu-lock/owner.json`: heartbeat + pid liveness, takeover past `--ttl-ms`. ADAPTER only, never CPU.
- Never `git worktree remove` a `scripts/worktree-setup.mjs` worktree (node_modules junction deletes `node_modules/.bin`); use `scripts/worktree-teardown.mjs`.
- gm spool: `in/<verb>/<session_id>-<random8>.txt`; write sibling `.tmp`, RENAME onto `.txt` (straight write dispatches torn body, "query required"); never reuse suffix. codesearch reads WORKING tree. Comment sweep: `codesearch` `{"comments_only":true,"no_ignore":true}`.
- CI: completing jobs = `check` + `frame-time-coverage`; `frame-time` carries `if: vars.CI_GPU_RUNNER_ONLINE == 'true'`, so no runner + var unset = SKIPPED, never `queued`. `concurrency` group PER SHA; per-ref group cancels older pending runs even with `cancel-in-progress:false`. CI Node 20 vs box Node 24.
- Witnesses run POSIX too: Windows-absolute path into `fetch`/`new URL` throws `Failed to parse URL from /home/runner/...` on Linux CI; box-collider fallback hides it.
- `npm run check` (gpu-free arm -> opt-in `SPOINT_GPU_WITNESS`) parses only tracked `src,client,apps,scripts,bin`, refuses browser/GPU witnesses by name; witness must exit 0 AND print `RESULT: PASS`.

## Repo boundaries

- `design` ships as pinned CDN URLs in `client/{index,landing/index,editor/thebird-host}.html` + `scripts/bundle-client.mjs`. `vendor/*` editing-only submodules (edit on own `main`, push, then commit gitlink); all UI built in `AnEntrypoint/design`.
- `apps/*` never imports `client/*` (singleplayer Worker resolves relative specifiers vs virtual root); expose utilities on `engineCtx`.
- Keep Node-only dynamic import specifiers opaque to esbuild/wrangler: build in IIFE, `(() => './' + 'ServerAPI' + '.js')()`. `edge/cf-do/spoint-do.js` imports `jolt-edge-init.js` BEFORE `WorkerEntry.js` (`globalThis.__SPOINT_EDGE_BUNDLED__` set at its top level).

## Debugging discipline

- Bug surviving threshold change = not fixed; re-diagnose. Fixing failure end-to-end at its own layer = second copy of same check (`ShapeBuilder.js`, `cluster-lod-mesh.js`).
- `src\win\async.c:76` = libuv `uv_async_send` assert: fires at `process.exit()` with handles mid-close; headless scripts await `process._getActiveHandles()` hitting 0.
- Witness needing server to act on client message passes `--params=multiplayer`; `?singleplayer` sees `players:0`, acks `ok:false`. `net::ERR_ABORTED` = cancellation; only real failure or HTTP >= 400 fails arm. Harness returning uncompared `{expected, got}` passes either way: one `expect()` per measurement, non-zero exit.
- One `gl.getError()` code covers distinct bugs (1282 = feedback-loop, sampler-type-mismatch AND insufficient-buffer-size): read driver's own console string off cache-disabled reload.
- Node deprecation warnings (DEP0152 + siblings) reach `console.error` via warning handler: bucket leading `(node:PID) [DEPnnnn]` separately.
- Troubleshooting (`scripts/lib/`): `head-vs-worktree.mjs <paths>`, `gm-dispatch.mjs <verb> [body]` when MCP detached, `witness-audit.mjs`. Full disk fails every verb — reclaim stale `.gm/browser-chrome-profile-*` first.
- `witness-audit.mjs --gate` = gpu-free arm of `npm run check`: per-file per-check counts vs committed `.witness-audit-baseline.json`; fails on absent check id or count above it, so a witness that cannot fail cannot land. Baseline is a floor to ratchet down: `--write-baseline` re-records, dropped count prints stale-baseline without failing.

## Entry points

- `ctx.defineGameFSM(spec)` `src/behaviours/game-fsm.js`; `ClientMachine.js` xstate5 parallel, fallback `after:` 10 s gated / 45 s hard stop.
- `ctx.defineFire(spec)` `src/behaviours/fire.js` (wired at `AppContext.js:387`, default off).
- Test relocation: `window.__spoint` + `MSG.TELEPORT` (0xc2 / ACK 0xc3, `src/sdk/Relocation.js`; no `EDITOR_TOKEN` = any client, `relocation:false` disables, >87 deg refuses). `window.__spoint._drive` = `Relocation.js drive()` — wrap it to OBSERVE input.
- Client app's `ctx.state` = entity `custom` block (`AppModuleSystem.js:82`), not server app state (`AppRuntime.js:686`): `ctx.state.<key> ?? literal` takes literal forever. `engine.cam` = camera CONTROLLER, no `position` — read `engine.client.getLocalState().position`.
- Wireweave attach helpers run after awaits (host migration reassigns `client` at `app.js:2666`): re-check at call time.
- `createServer()` per-call factory; `boot()` SIGINT/SIGTERM handlers process-global: stop with `RoomDirectory.stopAll`.
- Remote server's `netcode.profile` named only when client = real `PhysicsNetworkClient`: boot that witness on `?connect=...&multiplayer=1`, else falls back to in-page `BrowserServer`.

## Fire

- Integer-only kernel `fireKernel.js`: decisions from `hash(seed, step, face, I, J)`, no float / `Math.random` / `Date.now`.
- Rain smothers, does not eat fuel: rain-suppressed cell still burns `burnRate`, pushes no heat, spots nothing (`fireKernel.js burnCell`). `rainPerIntensity` (255, `fireSpec.js:148`) maps intensity 0..1 to roll byte; per-world `weather` block pins it.
- `ctx.navCostAt(x,z)` = 8 burning / 2 charred; `canSee` smoke-gated via `_fireNavByRuntime` at depth >= `smokeBlockDepth`.
- Wind = weather vector (BASE) + `hash(seed, step)` gust, clamped +-16 per axis; `snapshot().wind` carries BASE only.
- Per-cell initial fuel not recomputable in kernel (`classify()`, `VegPlacement.js:170-234`); per-tile array added to `snapshot()`/`restore()` joins `TILE_ARRAYS` (`fireKeyframe.js`) + VERSION bump (now 6).
- Tampered keyframe rejected at DECODE, named `[fireKeyframe]` error. `G` = ignition step mod 256, not age; IGNITE_AREA kind 5.
- Boundary snapshot's `delta` rolls back step BEFORE it (`takeDelta` at t=K reads `preStep` captured at K-`stepTicks`); restore verifies against boundary's `counters`, never its `delta`. `adopt`/`rewindTo`/`submit` return `{ok, reason, detail}`; `adopt` refuses snapshot failing `validateFireSnapshot`.

## Planet-wide multiplayer

- One server world per cluster, each own flat chart. Jolt heap fixed `JOLT_WASM_HEAP_BYTES` 134217728 B (`src/shared/clusterConfig.js:8`), never grows; over it `new J.JoltInterface` (`src/physics/World.js:65`) raises `Aborted(OOM)`.
- Three limits, not one cap: `maxContactConstraints` under requirement drops contacts silently; `maxBodies` under population makes Jolt return body id 0, so overflow bodies share one map key and `destroy()` aborts wasm.
- Assignment pure, hysteretic, antipodal-safe, 2-4 Hz; `resolveClusterConfig` refuses link below relevance ring or longest weapon range.
- Collider rings (`ColliderStreamer.js`): `DEFAULT_MAX_CENTERS = 192` BOTH trunk + rock streamers; rings per connected player, never centroid. `classifyRings` per-cluster quota resets every pass, first-fill, no guarantee; `evictOverCap` farthest-first; boot ring placement generation-bound vs `COMPUTE_BUDGET_MS` 2.5 ms.
- `planetRadius` is 0 in EVERY shipped world: `src/stage/Stage.js:8` sets `spatial.planetRadius = config.planetRadius || 0` and no world def assigns it, so `src/sdk/TickHandler.js:230` is always 0 and the cube-sphere branches (`resolvePlayerCell` `TickHandler.js:176`, `solveCellViewer` `TickHandlerAOI.js:119`, `computeRingRelevantIds` `TickHandlerAOI.js:161`) never execute -- only the flat ring path is live or covered.

## Chart re-anchor

- Chart-local server holders migrate via `src/sdk/chartState/` (`attachServerChartMigrators(ctx, service)`, default off). Re-anchor = change of basis, not rotation: position, velocity, forward invariant. CHART_REANCHOR = 0xc6; epoch u32 rides snapshot header + input/fire/teleport.
- Flat chart's intrinsic tilt fixed by shrinking chart: `CHART_ANCHORS_PER_FACE = 32`. `CHART_REANCHOR_ANGLE_DEG` (28 / 14) must exceed worst angle of its `createChartAnchorLattice` or anchor thrashes.
- Exactly ONE chart per world; two players at separation Delta sit at Delta/2, walkable iff `terrainTilt + Delta/2 <= 45 deg`.

## Physics and Jolt

- `physics.setBodyMotionType` returns NEW body id or `false`; recreation creates new body BEFORE destroying old, on `LAYER_DYNAMIC`, refusing body holding constraint, vehicle chassis or trimesh/mesh/heightfield shape.
- Pooled body whose `bodyMeta.type` != requested motionType = destroyed + replaced (`scaledShapeKey()` encodes model|scale only); matching slot revives via `_revivePooledBody`; `removeBody` on pooled DYNAMIC does `DeactivateBody`, zeroes both velocities.
- `BodyInterface.GetPosition` returns ONE shared temp, so two calls alias — `addConstraint` reads default anchors via `getBodyPosition`. Forced `removeBody(id, true)` destroys body; cached shape dies with LAST body using it.
- Jolt recycles removed bodies' tree nodes only in `physics.step`: re-adding thousands of bodies with no step between aborts wasm.
- Jolt `HeightFieldShape` exposes `GetMinHeightValue()`/`GetMaxHeightValue()`/`GetSampleCount()`, NOT `get_mMinHeightValue`; `GetSampleCount()` = PER-SIDE count (N), not N*N.
- Trimesh/convex collider build failure in `src/apps/AppPhysics.js` PROPAGATES as `ColliderBuildError`, never degrades to 0.5 m box; `AppRuntime` `config.autoTrimesh` branch + `EditorHandlers.js` still box.
- `AppRuntimePhysics.js` skips `e._vehicleId != null` in BOTH `_tickPhysicsLOD` + `_enforceBodyBudget`. Height samples snap to 1 mm via deliberate `+ 0`: `Math.round` of sample in (-0.5 mm, 0) yields -0; -0/+0 differ as `Float32Array` bits.
- `VehiclePhysics.js`: never `J.destroy` `v.constraint`/`v.tester` after `RemoveConstraint`, never destroy `get_mTracks()` copies after `set_mTracks`; empty `mDifferentials` = zero wheel torque.
- EDITOR_UPDATE calls `syncEntityCollider` AFTER `changeBodyType` (which removes body, synthesizes default box `_bodyDef`, clobbering `custom._collider`).

## Terrain and colliders

- `solveSurfaceY` tolerance absolute `1e-4` (`SURFACE_SOLVE_TOLERANCE_M`, `PlanetFrame.js:3`), 64-eval cap, throws `SurfaceSolveError`; past 63.6 km returns `-(R+anchorHeight)`, NO throw.
- Baked heightfield FAIL-LOUD (`src/terrain/TerrainPhysics.js`): absent = silent CPU fallback; unreadable/truncated/bad-magic/stale-code-version throw named `[baked-heightfield]` error (file, expected, actual). `hashVersion`/`terrainKey`/`chartEpoch` mismatch warns + falls back: different terrain, not damage.
- No terrain FATAL: `ServerAPI.loadWorld` rethrows `[terrain] world "<id>" has no terrain`; every caller stops server it created first.
- Two height backends; v2 = parity backend, carves (`terrainCarvesOf`) v2-only. On hashVersion 1 boot frame ground = GPU patch collider while `frame.elevationAtDir` still CPU sampler.
- `elevationAtLocal(frame,x,y,z)` exactly `|p|-radius`; app-facing `ctx.terrainHeightAt` NOT that.
- `PlanetFrame.groundHeightLocal` caches `SurfaceSolveError`, keyed by EXACT `(x,z)` + chartEpoch.
- `terrain.glsl` `snoise3`/`vnoise2`/`seaHash`/`hpfSample` take in-cell fraction as `P-floor(P)` from ONE `floor`. Cube-face frame duplicated across `faceFrame()`/`hpfFaceUV()`/`faceWarp`, `gl-render.js _faceFrames`, `FACE_FRAME` in `planet-orchestrator-cull.js`/`patch-baker.js`/`anchor-field-bands.js`.
- Server terrain collider lives in ONE fixed-anchor local tangent plane (`createPlanetFrame`, `anchorDir` default [0,1,0], never re-anchored): cannot represent directions past ~87 deg from anchor.
- `gl-render.js sampleGroundM` fire-and-forget async (PBO+fence): each call returns PREVIOUS call's harvested height; non-rAF callers use `sampleGroundMSync`, which poisons next async collision read.
- `VegPlacement.js`/`RockPlacement.js` read climate before `surfaceOfCell` only when `climateUsesLocalXZ !== true`. Veg density must gate on painted snow, else surviving grass weight roots trees.
- REFUTED, do not retry blind: 2-tap forward difference in `src/terrain/PlacementChart.js radialSlopeAt` — gradient crosses `SLOPE_MAX` 0.6, flipping gate decisions.

## Netcode and wire

- Prediction suppresses only blocked DIRECTION: `_reconcile` (`PredictionEngine.js:354`) derives `wedgeNormal` in `_updateServerBlock` (368) from commanded-vs-achieved motion, else `-velocity` when stopped while commanding; `shared/characterStep.js:41` projects out that component alone. `horizontallyWedged` = "a direction is blocked", not "motion stopped".
- `msgpack.js` `WIRE_STRUCTURES[1]` lists exactly keys, in order, of `TickHandler.js _packPayload` (seq,tick,serverTime,players,entities,removed,delta,dots). msgpackr 2.0.4 writes -0 as `0x00`; `patch-deps.mjs` excludes -0 from both integer tests.
- `PhysicsNetworkClient.connect()` REJECTS, named `TransportConnectError` (`err.reason`: `websocket-unavailable`|`websocket-error`|`websocket-closed-before-open`|`connect-superseded`), not `connected:false` + no socket; retry belongs in caller (`_doReconnect`), never in fake success.
- Wire v3 player record: 8 fields in 22-byte bin; `[inputSequence, inputBuffer, groundNormal]` ride per-recipient `me` block, so snapshots pack per recipient. `getSnapshot()` keys on `_version === _snapshotVersion` alone (tick gone).
- `SnapshotGroupPlanner`: groups = `ceil(viewers*perViewerMs/(budgetMs-fixedMs))`, budget = tick period * `SNAP_COST_HIGH_FRAC` 0.35 (`TickHandler.js:30`). Interest management off by default: `relevanceRadius || 0` (`server.js:67`) returns every player.
- Lockstep: rollback input-capped, so measure by depth, not rate (`maxRollbackTicks` 12); `inputDelayTicks` above `INPUT_RETAIN_TICKS` (240) throws at construction. Per-tick gameplay timer is tick-indexed, never `Date.now()`.
- Socket becomes player by MIGRATE, RECONNECT, or silence past MIGRATE-peek grace (`ServerHandlers.js onClientConnect`, 50 ms / 1500 ms dilated) — silent probe joins as phantom, so probes use `?probe=1`. Never answer unresolvable RECONNECT with INVALID_SESSION and leave it open: `rejectSession` flushes + closes; refused MIGRATE closes.
- Migration keeps old transport as fallback owner, hands player back on candidate death; close from transport client no longer owning cannot tear it down.
- Authoritative path: prediction off by default (`?predict` only); rollback/lockstep unwired. `TickHandler.js processPlayerMovement` takes ONE input per tick, catching up only while `inputs.length > INPUT_BUFFER_CATCHUP_DEPTH` 8, `extra < MAX_CATCHUP_STEPS_PER_TICK` 3, `player.inputStepBudget >= 1`; `INPUT_STEP_BANK` 16 caps speedup.
- `BaseClient.js sendInput` stops feeding `predEngine.addInput` once `predictionLeadSteps()` reaches `MAX_PREDICTION_LEAD_STEPS` 16; fast client degrades to bounded lead.

## Rendering

- `WebGPURenderer` DEFAULT (`?legacygl=1` opts out); unavailable WebGPU retries with `forceWebGL=true` before legacy, so TSL only shader path. WebGPU consumes TerrainBackdrop's `fE` DIRECTLY as per-vertex clip transform; WebGL uses `fE` only for CPU frustum culling.
- `three.webgpu.js` (pinned 0.185.1) drops pending `popErrorScope()` rejection unhandled at 3 sites; `patch-deps.mjs` patches all three.
- `patch-grid-render.js _ensureInstanceBuffer` must NOT reference-equality-guard reused array. `ClusterLodMesh._render` fires once PER GROUP per frame: keep `_lastRenderFrame===frame` early-return.
- `webgpu-hiz-shaders.js` compute cull stays algebraically equal to CPU paths (`isOccludedBox` `minZ >= texel + 1e-5`). Vegetation LOD classifies whole cells on uniform grid (`MAX_CELLS`, `GRID_MIN_OCCUPANCY`).
- Veg LOD: `WebGPULodInstancer` oracle mirrors `updateLOD` — `lodEye` refreshes only after camera moves `LOD_REEVAL_MOVE_SQ` (0.5 m), `addInstances`/`removeInstances` set `lodStale = true`. A species' leaf instancer is a SATELLITE of its branch (`opts.host`): no own grid, `updateLOD` returns immediately, tier/shadow/visibility mirrored; mutating one side of pair alone throws or diverges.
- Every discard in `terrain.glsl` FS stays inside `#ifdef _WATERPASS_` (discard anywhere disables early-Z depth write for all its draws). It = SoT for CPU/GPU height parity (`gen-height.mjs` transpiles it); deleting it needs new SoT + TSL/WGSL->JS generator.
- `invertAcesFilmic` must NOT end in `max(x, 0)`: saturated blue inverts out of AP1/ACES gamut. `ShadowPipeline.js forceUpdate` sets EVERY cascade `light.shadow.needsUpdate`; `cascadeCount` clamps to 1 when `sun.castShadow===false` (cascade 0 IS sun, never renders).
- Vegetation `InstancedMesh2`: `sortObjects` stays false with LODs; `CullFreeze.js setInstancedCullAuto` sets `autoUpdate` on parent AND every LOD level. Hand-written `ShaderMaterial` reaching grass/veg includes `<instanced_pars_vertex>`; `model-pool.js` drains allow >=1 unit/frame or zero budget deadlocks.
- Wall-clock budget buys WAITING, not work. Veg+Rocks `prewarm` budget WORK sliced 24 ms on macrotask yield; `minChunks` = floor. But `Grass.prewarm` (`Grass.js:388`) budgets WALL-CLOCK, rAF-yielding every 8 chunks, so waits charge against `PLAYABLE_BUDGET_MS`.

## Client and app runtime

- HUD `applyDiff(uiRoot, hudVdom)` replaces uiRoot children every frame; imperative DOM overlays mount on `document.body`.
- `_buildWorldScenery` joinable wrapper; boot adopts running build (`Promise.race` does not cancel loser); adopt branch not gated on `window.__terrain`.
- `app.js animate()` returns early while `window.__warmupInFlight`; model-pool + streaming loads pump from frame jobs there, so never park a wait inside warmup. Two interleaved `renderer.render` passes on one GL context let `ClusterLodMesh onBeforeRender` rewrite shared geometry.groups/index mid-pass.
- Client `WORLD_DEF` from `sendWorldDefAndModules` has `entities` STRIPPED, carries `_modelUrls`: derive world-entity facts from `_modelUrls`.
- Hot reload releases ctx via `AppRuntime._releaseAppContext`; `update()` keeps running with torn-down ctx unless `_updateList`/`_rebuildCollisionList` rebuilt.
- `AppRuntime._attachApp` does `apps.set` BEFORE awaiting `setup()`; `spawnEntity` attaches apps fire-and-forget, so collect tagged entities on first `update()` tick.
- Spawn: `holdSpawnUntilGrounded` (`src/sdk/Relocation.js:71`) gates release on `terrainFieldMissingAt`/`coversPosition` (max `SPAWN_HOLD_MAX_MS=20000`).
- Respawn clearance shared: `src/apps/AppGameplay.js pickSpawnPoint` + tps-game use one `footprintBlockers` sampler (17 down-ray columns; surface > `MAX_FOOTPRINT_INTRUSION_M` 0.15 m above column bottom = `intruding`) plus 8 directions x 5 capsule heights, each requiring radius at that rise.
- `BrowserServer.js`: `_lastTodSync` + `_deliveredWorldFingerprints` MODULE level — stall recovery + HostMigration rebuild fresh BrowserServer in same page.
- Singleplayer worker world identity from `INIT.worldName`; snapshot = one IDB key `world-snapshot` per origin; switching worlds discards by mismatch.
- `FloatingOrigin.js update()` does `camera.position.set(0,0,0)` on rebase, not `+= -delta` — `app.js` rewrites it each frame.

## Measurement and witnessing

- Every named GPU arm pins its adapter: `vendorGpuArgs(vendor)` adds `--use-adapter-luid=0,<luid>`; `gpu-probe.mjs gpuLaunchArgs()` does NOT. Pinning necessary, NOT sufficient — Chrome ignores unresolvable LUID while reporting accelerated, so assert renderer string (`assertGpu`/`witnessGpu`). AMD LUID per-boot (`adapterLuidFor('amd')`).
- REFUTED: AMD iGPU does not lose GPU context at boot; hang was `probeGpu()` minting a fresh WebGL2 context in the page measured, so `probeGpu` reads `window.__rendererInfo`. Never mint a context in a page you measure.
- Software rasterizer cannot reach gate floor, so frame-time arm needs accelerated runner. Vsync-locked p50 = refresh divisor, not work; `frame-time-gate.mjs` unlocks rAF. Baselines PER-VENDOR (another adapter's refused; unbaselined vendor fails loudly): AMD 18.39 ms `ee756369`, NVIDIA 9.03 ms `76059b48`, 5207 veg both.
- AMD iGPU DOES expose `timestamp-query`, so `--gpu-passes --extra=gputime=1 --backend=webgpu` works (`npm run build:client` first or FATAL): 1080p GPU p50 25.36 ms vs 15.88 ms CPU = GPU-bound; NVIDIA 5.18 ms, vsync-locked, NOT GPU-bound. Per-stage split NOT delivered (ctx0 fuses terrain+veg+sky). Use p50: pass-total mean ~14% low.
- Contention gate needs a GPU-bound control page: refuses on no cadence, floor unreached, quantum at 1.5x own p50, before/after >1.25x; no capture writes slower baseline (`--accept-slower=<reason>`).
- AMD frame-time verdict needs quiet window (`gpulock` = ADAPTER only, never CPU): verify FAIL naming CPU contested = shared box.
- WebGPU `Info`: `info.render.calls` CUMULATIVE, only reliable liveness signal (`drawCalls`/`.triangles` read 0). TSL-vs-legacy parity written BEFORE any frame: region matches iff cross-renderer meanAbs/channel <= 3 x max(same-renderer noise floor, `QUANT_FLOOR`).
- Decide perf rows on counted work units: ms-per-tick counter = no measurement, never-incremented counter a silent pass — confirm field exists on measured backend (`vegProfile.meshInstances` absent on `WebGPULodInstancer`). Authoritative draw count = `perf-run.mjs drawsInstrument.authoritativeField`.
- `prediction-drift-witness.mjs` diagnostic for "client led server": caps peak unacked (24), peak divergence (3 m), last 5 samples under `--settle-tol` (0.5 m); `--server-tick=<hz>` only lever. Two arms alternate per rep, each axis gated vs rep-to-rep spread; inert horizon reports "no separation gain".
- CDP `Input.dispatchKeyEvent` reaches app input bucket — read `window.__app.sentInput`/`sentInputCount`; `perf-run` `inputReachedGame` needs the held leg's movement bit + `sentInputCount` advanced. Keyboard sets `input.backward`, never `input.back` (`InputHandler.js:160`). `[physics] peak active 0` = not a stalled player (`CharacterVirtual` never counted by `GetNumActiveBodies()`).
- A witness with a fixed scratch dir must `rm` it at start: a gate run killed at its 120 s cap leaves it behind and later runs hang on it (`terrain-reseed-failure-witness.mjs`, `956b91e2`).
- gm `exec_js` dispatches ephemeral: server booted in one gone by next. Use `127.0.0.1`, not `localhost`.
- Headless Node witness constructing `PhysicsNetworkClient` must polyfill `globalThis.WebSocket` from `ws` — Node 20 has none, so every multiplayer arm fails "only 0 of 2 client(s) joined".
- `edge-collider-draco-witness.mjs` rewrites tracked `apps/tps-game/*.glb` in place — never run inside gate.

## Security

- Re-run dependency scan on any fresh or updated `node_modules` (HiddenSpawn second-stage loader already cleaned).
- `SESCompartmentEvaluator.js` only untrusted-app evaluator, fails closed, no proxy tier; `StaticHandler` enforces path containment + COEP `require-corp`. Failed `import('ses')`/lockdown throws `SandboxUnavailableError` (SANDBOX_UNAVAILABLE); first-party `apps/` never touch it.
- `authCompare.js timingSafeTokenEqual` self-compares (`bufA,bufA`) on length mismatch so token length not leaked — do not simplify away.
- Benign exec surfaces, never flag as malware: `lang/spoint.js`, `mapspinner/planet.html`, `scaffold.js`, `cdp-browser.mjs`.

@.gm/next-step.md
