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

One line per fact. Rules, thresholds and file:line stay here; numbers, scenarios and derivations live in the memo tier: `mem-0b6d4c2f9e1a8735-1204` measurement/GPU · `mem-1c7e5d3a0f2b9846-2315` physics/terrain · `mem-2d8f6e4b1a3c0957-3426` netcode · `mem-3e9a7f5c2b4d1068-4537` rendering · `mem-4f0b8a6d3c5e2179-5648` fire/cluster/chart · `mem-a6f1d7bd7be3412c-3784` live-GL playbook · `mem-e44338278288dcd3-1912` AMD box contention.

## Working rules

- Main-only branch; commit only as lanmower (`git_commit` explicit `paths`, never `git add` + bare commit, `0292ad7b`). Co-author trailers are one-way (`auto-declaudeify.yml`).
- Generated artifacts travel with source: `AppContext.js` -> `sdk-typings.generated.d.ts` (gate regenerates from committed HEAD); a height-code change re-bakes `apps/world/*.hf`.
- `core.autocrlf=true`: tree CRLF, index LF; `w/crlf` in `git ls-files --eol` is not a diff. Disk copy drifted to CRLF against an LF blob reads as whole-file rewrite in `git_diff` — normalize first (hid a real 95-line `TerrainPhysics.js` change).
- `.gitignore` exempts only `.gm/disciplines/project/` from `.gm/*`: a tracked memo outside it is silently uncommittable (`git_commit` succeeds, `git_show --name-only` omits it).
- `@spoint/ecs` is the only `@spoint/*` specifier; its link vanishes mid-session and kills every harness — `npm run links` restores it, never `npm install`.
- `scripts/gpulock.mjs run <owner> [--wait-ms N] [--ttl-ms N] -- <command> <args...>` serializes accelerated arms across agents through `.gpu-lock/owner.json` (heartbeat + pid liveness, takeover once past `--ttl-ms`, refuses with a named error after `--wait-ms`); `status` and `release` inspect it. It propagates the child's exit code, so callers no longer grep for `RESULT:`. Every accelerated arm must hold it: two arms on one adapter measure each other, and host CPU stays clean while they do, so host-contention cannot see it.
- Never `git worktree remove` a `scripts/worktree-setup.mjs` worktree (its node_modules junction deletes `node_modules/.bin`); use `scripts/worktree-teardown.mjs`.
- gm spool: `in/<verb>/<session_id>-<random8>.txt`, `.txt` or swept unexecuted; never reuse a suffix. Write sibling `.tmp` and RENAME onto `.txt` — a straight write dispatches a torn body ("query required"). codesearch reads WORKING tree, so another lane's edit can hide a committed constant. Comment sweep: gm `codesearch` `{"comments_only":true,"no_ignore":true}`; the `refresh` field is REJECTED; `glob` matches FILENAMES.
- CI: `check` job (`ubuntu-latest`, `npm ci` + `npm test`) is the only completing job — `frame-time` declares `runs-on: [self-hosted, Windows, gpu]`, no such runner online, so every run holds one job queued and `gh run list` reports `queued` whatever `check` did. Read the per-job verdict, never the run status (`ci-verdict.mjs <sha>`; logs mid-run `gh api .../jobs/<jobId>/logs`).
- Witnesses must run on POSIX too: a Windows-absolute path fed to `fetch`/`new URL` throws `Failed to parse URL from /home/runner/...` on Linux CI; a box-collider fallback hides it (`fire-tps-game-witness.mjs`).
- `npm run check` (gpu-free arm -> `fire-witness-gate.mjs` -> `check-frame-time-baselines` -> opt-in `SPOINT_GPU_WITNESS` veg arm) parses only tracked `src,client,apps,scripts,bin`, refuses browser/GPU witnesses by name; a witness must exit 0 AND print `RESULT: PASS` (a TypeError crash prints no `RESULT:` line, failing twice).

## Repo boundaries

- `design` ships as pinned CDN URLs in `client/{index,landing/index,editor/thebird-host}.html` + `scripts/bundle-client.mjs` (`anentrypoint-design` -> unpkg `1.0.34/dist/247420.{js,css}`).
- `vendor/*` are editing-only submodules: edit on their own `main`, push, then commit the gitlink; all UI is built in `AnEntrypoint/design`.
- `apps/*` must never import `client/*` (singleplayer Worker resolves relative specifiers against a virtual root); expose utilities on `engineCtx` (`engine.THREE`, `ctx.kit`).
- Keep Node-only dynamic import specifiers opaque to esbuild/wrangler: build them in an IIFE, `(() => './' + 'ServerAPI' + '.js')()`.
- `globalThis.__SPOINT_EDGE_BUNDLED__` is set at `jolt-edge-init.js` top level, so `edge/cf-do/spoint-do.js` must import it BEFORE `WorkerEntry.js`.

## Debugging discipline

- A bug surviving a threshold change was not fixed; re-diagnose. A fix failing end-to-end at its own layer means a second copy of the same check exists (`ShapeBuilder.js`, `cluster-lod-mesh.js`).
- `src\win\async.c:76` is libuv's `uv_async_send` assert: it fires at `process.exit()` with handles mid-close, so headless scripts await `process._getActiveHandles()` reaching 0.
- A witness needing the server to act on a client message passes `--params=multiplayer`; `?singleplayer` sees `players:0`. `net::ERR_ABORTED` is a cancellation; only a real failure or HTTP >= 400 fails an arm. A harness returning an uncompared `{expected, got}` passes either way: one `expect()` per measurement plus non-zero exit.
- `window.__spoint._drive` is `Relocation.js drive()`, called by `app.js` each input step; wrapping it is the sanctioned way to OBSERVE input.
- One `gl.getError()` code covers distinct bugs (1282 = feedback-loop, sampler-type-mismatch AND insufficient-buffer-size), so read the driver's own console string off a cache-disabled reload.
- Troubleshooting (`scripts/lib/`): `head-vs-worktree.mjs <paths>` committed-vs-in-flight, `agent-report.mjs <task-id>` a huge transcript, `gm-dispatch.mjs <verb> [body]` when MCP is detached, `witness-audit.mjs` dead gates, `ci-verdict.mjs <sha>` per-sha CI (0 green / 1 red / 2 none / 3 pending), `ci-logs.mjs <sha> [--tail=N] [--match=re]` the failing job's cause line(s) and tail with runner scaffolding stripped (`--commit` needs a full sha, so it resolves a short one through `git rev-parse` and falls back to a prefix match over the last 20 runs). A disk that fills up fails every verb at once: `.gm/browser-chrome-profile-*` is one ~0.13 GB directory per session name with no retention, and it reached 49 GB here (`git add` then fails `unable to write loose object file: No space left on device`), so reclaim stale profiles before chasing the symptom.
- `witness-audit.mjs --gate` runs as a gpu-free arm of `npm run check`: it compares per-file per-check finding counts against committed `.witness-audit-baseline.json` and fails on any check id absent from it or any count above it, so a witness that cannot fail cannot land unnoticed. `--write-baseline` re-records it after a fix; a count that drops prints stale-baseline without failing, and the baseline is a floor to ratchet down, not an allowance. `--gate` and `--write-baseline` read `git ls-files -- scripts` blobs at HEAD, not the working tree, so a lane's uncommitted fix cannot make the local run pass while CI tests what actually shipped; `--worktree` opts out for editing, `--committed` opts in for a plain scan. Its `ws-polyfill-missing` check catches a Node witness that reaches a `ws://` URL with no `globalThis.WebSocket` assignment and no `ws` import -- on a runner whose Node has no global WebSocket every client there fails to connect and the arm exits before measuring.

## Entry points

- `ctx.defineGameFSM(spec)` `src/behaviours/game-fsm.js`; `ClientMachine.js` is xstate5 parallel, fallback `after:` 10 s gated / 45 s hard stop; editor REPARENT/DUPLICATE/SET_LABEL are 0x94-0x96.
- `ctx.defineFire(spec)` `src/behaviours/fire.js` (wired at `AppContext.js:387`, default off); design recall slug `project/fire-system-design-2026-10-05`.
- Default world `apps/world/index.js` `defaultWorld`; validated `worldResolve.js`, defaulted `worldDefaults.js` (tick 60, spawn [0,5,0], `DEFAULT_PLAYER_MODEL` `/assets/default-avatar.vrm`).
- Test relocation: `window.__spoint` + `MSG.TELEPORT` (0xc2 / ACK 0xc3, `src/sdk/Relocation.js`; no `EDITOR_TOKEN` = any client, `relocation:false` disables, >87 deg refuses).
- A client app's `ctx.state` is the entity's `custom` block (`AppModuleSystem.js:82`), not server app state (`AppRuntime.js:686`): `ctx.state.<key> ?? literal` takes the literal forever. `engine.cam` is the camera CONTROLLER with no `position` — read `engine.client.getLocalState().position`.
- Wireweave attach helpers run after awaits (host migration reassigns `client` at `app.js:2666`): re-check at call time (`d6cf7bc7`).
- `createServer()` is a per-call factory; `getJolt()`'s WASM and `boot()`'s SIGINT/SIGTERM handlers are process-global: stop with `RoomDirectory.stopAll`.
- APP_EVENT payloads arriving before the client app module is evaluated are dropped by `onEvent`; pushes at `player_join` land in that window.

## Fire (`ctx.defineFire`)

- Integer-only kernel `fireKernel.js`: decisions from `hash(seed, step, face, I, J)`, no float / `Math.random` / `Date.now`. Cells are 2x2 veg placement cells (8 m); step boundaries are absolute ticks.
- Rain smothers, it does not eat fuel: a rain-suppressed cell still burns its `burnRate` but pushes no heat and spots nothing (`fireKernel.js burnCell`); zeroing `fuel` instead left rain 0.6 unable to sustain any fire. `rainPerIntensity` (default 255, `fireSpec.js:148`) maps intensity 0..1 to the roll byte, which scales with step length; a per-world `weather` block pins it.
- `ctx.navCostAt(x,z)` = 8 burning / 2 charred; `canSee` is smoke-gated via `_fireNavByRuntime` at depth >= `smokeBlockDepth`.
- Wind = weather vector (BASE) + `hash(seed, step)` gust (`fireWind.js`), clamped to +-16 per axis; `snapshot().wind` carries the BASE only.
- Per-cell initial fuel is not recomputable in the kernel (`classify()`, `VegPlacement.js:170-234`); any per-tile array added to `snapshot()`/`restore()` must join `TILE_ARRAYS` (`fireKeyframe.js`) with a VERSION bump (now 6).
- A tampered keyframe is rejected at DECODE with a named `[fireKeyframe]` error. `G` is the ignition step mod 256, not an age; IGNITE_AREA is kind 5, radius <= 8 cells.
- A boundary snapshot's `delta` rolls back the step BEFORE it (`takeDelta` at t=K reads the `preStep` captured at K-`stepTicks`), so a restore is verified against the boundary's `counters`, never its `delta`. `adopt`/`rewindTo`/`submit` return `{ok, reason, detail}`; `adopt` refuses a snapshot failing `validateFireSnapshot` not partial-restoring it.
- Gate witnesses `fire-smoke-los-witness.mjs`, `fire-wind-coupling-witness.mjs`, `fire-tps-game-witness.mjs`.

## Planet-wide multiplayer (`src/shared/clusterAssignment.js`)

- One server world per cluster, each its own flat chart. The Jolt heap is fixed at 134217728 B and never grows; over it `new J.JoltInterface` raises `Aborted(OOM)` (`src/physics/World.js:60`).
- The three limits are not one cap: `maxContactConstraints` under requirement drops contacts silently; `maxBodies` under population makes Jolt return body id 0, so overflow bodies share one map key and `destroy()` aborts the wasm.
- Assignment is pure, hysteretic, antipodal-safe, 2-4 Hz; `resolveClusterConfig` refuses a link below the relevance ring or the longest weapon range.
- Collider rings (`ColliderStreamer.js`): `DEFAULT_MAX_CENTERS = 192` for BOTH trunk and rock streamers (`1d8358bf`); rings are per connected player, never the centroid. `classifyRings`' per-cluster quota resets every pass and is first-fill, not a guarantee; `evictOverCap` removes farthest-first.
- The boot ring is placement-generation-bound against `COMPUTE_BUDGET_MS` 2.5 ms.

## Chart re-anchor

- Chart-local server holders migrate through `src/sdk/chartState/` (`attachServerChartMigrators(ctx, service)`; default off). A re-anchor is a change of basis, not a rotation: position, velocity and forward are invariant. CHART_REANCHOR is 0xc6; epoch u32 rides the snapshot header and input/fire/teleport messages.
- The flat chart's intrinsic tilt term is fixed by shrinking the chart: `CHART_ANCHORS_PER_FACE = 32` (`chartAnchor.js`, `b6af3ff0`). `CHART_REANCHOR_ANGLE_DEG` (28 / 14) must exceed the worst angle of its `createChartAnchorLattice` lattice or the anchor thrashes.
- Exactly ONE chart per world (`setupTerrainStreaming` calls `createPlanetFrame` once), so two players at separation Delta sit at Delta/2, walkable iff `terrainTilt + Delta/2 <= 45 deg`.
- `ChartReanchorTerrain.js`: HeightfieldStreamer fields are REBUILT off-path in slices, then installed; ColliderStreamer rings transform in place via `setBodyTransform`. `MinimapBiome.js sampleMinimapCell` is chart-independent to <0.0004 m.

## Physics and Jolt

- `physics.setBodyMotionType` returns the NEW body id or `false`, never the old; jolt 1.1.0 wasm-compat cannot make a Static-created body simulate via `SetMotionType` (`IsActive()` is the only discriminator), so it falls back to recreation: create the new body BEFORE destroying the old, on `LAYER_DYNAMIC`, refusing a body holding a constraint, vehicle chassis or trimesh/mesh/heightfield shape.
- A pooled body whose `bodyMeta.type` differs from the requested motionType is destroyed and replaced (`scaledShapeKey()` encodes model|scale only); a matching slot is revived via `_revivePooledBody`, and `removeBody` on a pooled DYNAMIC body must `DeactivateBody` and zero both velocities.
- `BodyInterface.GetPosition` returns ONE shared temp; two calls alias — `addConstraint` must read default anchors via `getBodyPosition` or the distance constraint gets min=max=0. A forced `removeBody(id, true)` destroys the body, and a cached shape dies with the LAST body that used it.
- Jolt recycles removed bodies' tree nodes only in `physics.step`: re-adding thousands of bodies with no step between aborts the wasm.
- A Jolt `HeightFieldShape` in the wasm-compat bindings exposes `GetMinHeightValue()`/`GetMaxHeightValue()`/`GetSampleCount()`, NOT `get_mMinHeightValue`/`get_mHeightQuantizationScale`; `GetSampleCount()` is the PER-SIDE count (N), not N*N. A probe calling the `get_m*` names reads null then checks nothing silently (`terrain-residency-seam-witness.mjs`).
- `GLBLoader` discriminates by URL SCHEME (`^([A-Za-z][A-Za-z0-9+\-.]+):`, >=2 chars so a Windows `C:` drive is not read as one), not by an `http`/`/` prefix: a scheme-less path is read from disk, `file:` decoded via `fileURLToPath`, anything else fetched.
- A trimesh/convex collider build failure in `src/apps/AppPhysics.js` PROPAGATES as `ColliderBuildError` not degrading to a 0.5 m box; `AppRuntime`'s `config.autoTrimesh` branch and `EditorHandlers.js` still box of their own accord and are separate rows.
- `AppRuntimePhysics.js` skips `e._vehicleId != null` in BOTH `_tickPhysicsLOD` and `_enforceBodyBudget`. `HeightFieldShape` quantizes over its own min/max. Height samples snap to 1 mm with a deliberate `+ 0`: `Math.round` of a sample in (-0.5 mm, 0) yields -0, and -0/+0 differ as `Float32Array` bits.
- `VehiclePhysics.js`: never `J.destroy` `v.constraint`/`v.tester` after `RemoveConstraint`, never destroy `get_mTracks()` copies after `set_mTracks`; empty `mDifferentials` = zero wheel torque. `apps/_lib/softbody.js`: EVERY particle body needs a massed collider, pinned or not; each cloth owns its own `RAPIER.World`.
- EDITOR_UPDATE must call `syncEntityCollider` AFTER `changeBodyType` (removes the body, synthesizes a default box `_bodyDef`, clobbering `custom._collider`). `StaticTileIndex.update` tiles static non-sensor bodies at 16 m XZ off a 16-value `Float64Array` bounds record.

## Terrain and colliders

- `solveSurfaceY` tolerance is absolute `1e-4` (`SURFACE_SOLVE_TOLERANCE_M`, `PlanetFrame.js:3`), 64-eval cap, throws `SurfaceSolveError`; past 63.6 km it returns `-(R+anchorHeight)` with NO throw.
- A baked heightfield is FAIL-LOUD (`896f3351`, `src/terrain/TerrainPhysics.js`): absent falls back to CPU silently, but unreadable / truncated / bad-magic / unreadable-header / longer-than-declared / stale-code-version each throw a named `[baked-heightfield]` error naming file, expected and actual. `hashVersion` and `terrainKey`/`chartEpoch` mismatch still warn-and-fall-back: those mean DIFFERENT terrain, not damaged bytes.
- No terrain is FATAL: `ServerAPI.loadWorld` rethrows `[terrain] world "<id>" has no terrain`; every caller stops the server it created first.
- Two height backends; `gpu-eval.mjs` exposes `__sampleHeights(dirs)`. v2 is the parity backend; carves (`terrainCarvesOf`) are v2-only. On a hashVersion 1 boot the frame ground is the GPU patch collider while `frame.elevationAtDir` is still the CPU sampler.
- `elevationAtLocal(frame,x,y,z)` is exactly `|p|-radius`; app-facing `ctx.terrainHeightAt` is NOT that. v1 CPU consumers: `MinimapBiome.js`, `relocation.js`, `PlacementChart.js`.
- `PlanetFrame.groundHeightLocal` memoises 4096 direct-mapped slots keyed by EXACT `(x,z)` + chartEpoch, caching `SurfaceSolveError` too.
- A heightfield's sample grid covers a half-open cell span, so neighbours disagree along a shared edge by a quantization step.
- `terrain.glsl` `snoise3`/`vnoise2`/`seaHash`/`hpfSample` take the in-cell fraction as `P-floor(P)` from ONE `floor`. The cube-face frame is duplicated across `faceFrame()`/`hpfFaceUV()`/`faceWarp`, `gl-render.js _faceFrames`, `FACE_FRAME` in `planet-orchestrator-cull.js`/`patch-baker.js`/`anchor-field-bands.js`.
- The server terrain collider lives in ONE fixed-anchor local tangent plane (`createPlanetFrame`, `anchorDir` default [0,1,0], never re-anchored): it cannot represent directions beyond ~87 deg from the anchor.
- `gl-render.js sampleGroundM` is fire-and-forget async (PBO+fence): each call returns the PREVIOUS call's harvested height; non-rAF callers must use `sampleGroundMSync`, which poisons the next async collision read.
- `VegPlacement.js`/`RockPlacement.js` read the climate before `surfaceOfCell` only when `climateUsesLocalXZ !== true` (sea-level XZ and surface XZ diverge by ~h*sin(theta)). Veg density must gate on painted snow, or the 1-2% of grass weight surviving a snow cell still roots trees.

## Netcode and wire

- Prediction runs no collision, so `resimulate()` walks the local character into geometry it is held against; the fix is a wedge flag gating the resim step when held. Replay/lockstep drift comes from dt, not Jolt.
- `msgpack.js` `WIRE_STRUCTURES[1]` must list exactly the keys, in order, of `TickHandler.js _packPayload` (seq,tick,serverTime,players,entities,removed,delta,dots). msgpackr 2.0.4 writes -0 as the byte `0x00`; `patch-deps.mjs` excludes -0 from both integer tests.
- `PhysicsNetworkClient.connect()` REJECTS with a named `TransportConnectError` (`err.reason`: `websocket-unavailable` | `websocket-error` | `websocket-closed-before-open` | `connect-superseded`), not `connected:false` with no socket; retry belongs in the caller (`_doReconnect`), never in a fake success — a harness ignoring a rejected `connect()` reports "0 of 2 client(s) joined" as a fire failure.
- Wire v3 player record: 8 fields in a 22-byte bin; recipient-only `[inputSequence, inputBuffer, groundNormal]` ride the per-recipient `me` block, so snapshots pack per recipient. `getSnapshot()` is keyed on `_version === _snapshotVersion` alone (the tick is gone); a per-runtime map reuses an encoding when a field-by-field compare finds no change.
- `SnapshotGroupPlanner`: groups = `ceil(viewers*perViewerMs/(budgetMs-fixedMs))`, budget = tick period * `SNAP_COST_HIGH_FRAC` 0.35 (`TickHandler.js:30`). Interest management is off by default: `relevanceRadius || 0` (`server.js:67`) makes `playersInInterest` return every player and no world sets it.
- Lockstep: rollback is input-capped, so measure by depth, not rate (`maxRollbackTicks` 12); `inputDelayTicks` above `INPUT_RETAIN_TICKS` (240) throws at construction. Any new per-tick gameplay timer in `AppRuntime` is tick-indexed, never `Date.now()`.
- A socket becomes a player by MIGRATE, by RECONNECT, or by staying silent past the MIGRATE-peek grace timer (`ServerHandlers.js onClientConnect`, 50 ms / 1500 ms dilated), so a silent probe joins as a phantom — probes use `?probe=1`. Never answer an unresolvable RECONNECT with INVALID_SESSION and leave it open: `rejectSession` flushes and closes; a refused MIGRATE closes the candidate without spawning.
- Migration keeps the old transport as a fallback owner and hands the player back on candidate death; a close from a transport the client no longer owns cannot tear it down (`transport-churn-witness.mjs`).
- Authoritative path: prediction is off by default (`?predict` only); rollback/lockstep are unwired. `TickHandler.js processPlayerMovement` takes ONE input per tick and catches up only while `inputs.length > INPUT_BUFFER_CATCHUP_DEPTH` 8, `extra < MAX_CATCHUP_STEPS_PER_TICK` 3 and `player.inputStepBudget >= 1` — never drop it to drain a backlog faster; the `INPUT_STEP_BANK` 16 bank is all that stops 4x-real-time movement.
- `BaseClient.js sendInput` stops feeding `predEngine.addInput` once `predictionLeadSteps()` reaches `MAX_PREDICTION_LEAD_STEPS` 16, so a fast client degrades to a bounded lead.

## Rendering

- `WebGPURenderer` is DEFAULT (`?legacygl=1` opts out); unavailable WebGPU retries with `forceWebGL=true` before legacy, so TSL is the only shader path. WebGPU consumes TerrainBackdrop's `fE` DIRECTLY as the per-vertex clip transform; WebGL uses `fE` only for CPU frustum culling.
- `three.webgpu.js` (pinned 0.185.1) drops a pending `popErrorScope()` rejection unhandled at 3 sites; `patch-deps.mjs` patches all three and `MapspinnerPipelineCache.getPipeline()` must error-scope `createRenderPipeline`.
- `patch-grid-render.js _ensureInstanceBuffer` must NOT reference-equality-guard a reused array (`collectQuads()` reuses one `quadsPool` every frame; that froze WebGPU terrain at frame 1). `ClusterLodMesh._render` fires once PER GROUP per frame: keep the `_lastRenderFrame===frame` early-return or a mid-frame cull/LOD re-run rewrites start/count of queued draws.
- `webgpu-hiz-shaders.js` compute cull must stay algebraically equal to the CPU paths (`hzb-tier.js _selectLevel`, `isOccludedBox` `minZ >= texel + 1e-5`). Vegetation LOD classifies whole cells on a uniform grid (`MAX_CELLS`, `GRID_MIN_OCCUPANCY`); `veg-instance-browser-witness.mjs` must walk the player until instancers report instances before measuring.
- `client/core/PlacementRing.js keysAround` must return `PlacementLattice.ringAroundDir`'s numeric chunk keys UNCHANGED (`90c2bcad`) and throw on a non-numeric entry — `r.key` over numbers made every distance NaN, so chunks loaded empty and unloaded forever. Witness ring changes on BOTH GPUs (`vegTotal`, `vegDraws`, `grassTotal` > 0) after `npm run build:client`; it serves `dist/client/app.js`, where a stale bundle only warns before falling through to raw ESM.
- Every discard in `terrain.glsl`'s FS must stay inside `#ifdef _WATERPASS_` (a discard anywhere disables early-Z depth write for all its draws). It is also the SoT for CPU/GPU height parity (`gen-height.mjs` transpiles it); deleting it needs a new SoT plus a TSL/WGSL->JS generator.
- Depth contract: mapspinner re-encodes terrain/water depth to `window.__hostNearFar` (`passPlanetDepthWriteback`). Rendered sea = sphere R (== `waterlineLocalY`) + waves ZERO-MEAN about it.
- `invertAcesFilmic` must NOT end in `max(x, 0)`: a saturated blue inverts out of AP1/ACES gamut. `ShadowPipeline.js forceUpdate` must set EVERY cascade `light.shadow.needsUpdate`; `cascadeCount` clamps to 1 when `sun.castShadow===false` (cascade 0 IS the sun, never renders). `QualityPresets.js` ships `ssao:false`/`bloom:false`.
- Vegetation `InstancedMesh2`: `sortObjects` must stay false with LODs; `CullFreeze.js setInstancedCullAuto` sets `autoUpdate` on parent AND every LOD level. A hand-written `ShaderMaterial` reaching InstancedMesh2 grass/veg must `#include <instanced_pars_vertex>`; `model-pool.js` drains must allow >=1 unit/frame or a zero budget deadlocks.
- A wall-clock budget buys WAITING, not work: `Vegetation.prewarm` sliced by chunk count, `await requestAnimationFrame` every 2 chunks, 64-chunk cap on a 1862-chunk ring — 98.4% rAF waits: 54 557 ms vs 2047 ms of placement compute, 10.2% of instances at reveal. It now budgets placement WORK, slices at `PREWARM_SLICE_MS` 24, yields on a macrotask, and `minChunks` is a floor, not a cap: reveal 500 -> 5073 NVIDIA, 4983 -> 5072 AMD. `Rocks.prewarm` needs the same slices.

## Client and app runtime

- HUD `applyDiff(uiRoot, hudVdom)` replaces uiRoot's children every frame, so imperative DOM overlays (lobby, EmoteWheel, PauseMenu, SettingsMenu, MinimapHUD) mount on `document.body`.
- Scenery: `_buildWorldScenery` is a joinable wrapper; boot adopts the running build (`Promise.race` does not cancel the loser). The adopt branch must not be gated on `window.__terrain`.
- `app.js animate()` returns early while `window.__warmupInFlight`; model-pool and streaming loads are pumped from the frame jobs there, so never park a wait inside the warmup — it starves that load (a residence wait moved in front of the flag cut reveal 17975 -> 6636 ms). Two interleaved `renderer.render` passes on one GL context let `ClusterLodMesh onBeforeRender` rewrite shared geometry.groups/index mid-pass.
- The client `WORLD_DEF` from `sendWorldDefAndModules` has `entities` STRIPPED and carries `_modelUrls` instead: derive world-entity facts from `_modelUrls`.
- Hot reload releases a ctx via `AppRuntime._releaseAppContext`; `update()` keeps running with a torn-down ctx unless `_updateList`/`_rebuildCollisionList` are rebuilt.
- `AppRuntime._attachApp` does `apps.set` BEFORE awaiting `setup()`; `spawnEntity` attaches apps fire-and-forget, so collect tagged entities on the first `update()` tick.
- Spawn: `holdSpawnUntilGrounded` (`src/sdk/Relocation.js:71`) gates release on `terrainFieldMissingAt`/`coversPosition` (max `SPAWN_HOLD_MAX_MS=20000`).
- Respawn clearance is per-app: `apps/tps-game/respawn-clearance.js` installed as `ctx.pickSpawnPoint` by tps-game `server-app.js setup` (17 columns, one down-ray each from under the capsule top: a miss is `void`, a surface > `MAX_FOOTPRINT_INTRUSION_M` 0.15 m above that column's bottom is `intruding`, a rim column's bottom sits at the capsule rise); `src/apps/AppGameplay.js pickSpawnPoint` (one centre column, horizontal rays at `centerHeight`, threshold = capsule radius) serves every other app and misses a blocker below `centerHeight`.
- `BrowserServer.js`: `_lastTodSync` and `_deliveredWorldFingerprints` are MODULE level: stall recovery and HostMigration rebuild a fresh BrowserServer in the same page.
- Singleplayer worker world identity comes from `INIT.worldName`; the snapshot is one IDB key `world-snapshot` per origin, so switching worlds discards by mismatch (`7d29891a8e`).
- `FloatingOrigin.js update()` must `camera.position.set(0,0,0)` on rebase, not `+= -delta` — `app.js` rewrites it from authoritative coords each frame. `EntityLoader.js _primGeoKey` must use the same ||-defaults as `MESH_BUILDERS` (capsule r0.3/h1.8).

## Measurement and witnessing

- Every named GPU arm pins the adapter it names: `vendorGpuArgs(vendor)` adds `--use-adapter-luid=0,<luid>`. Pinning is necessary but NOT sufficient — Chrome ignores an unresolvable LUID while still reporting accelerated, so assert the renderer string (`assertGpu`/`witnessGpu`).
- REFUTED (`7c968d0a`): the AMD iGPU does not lose its GPU context during tps-game boot — it boots and renders 3/3; the 10.6 s hang was `probeGpu()` minting a fresh WebGL2 context in the page it measured, so `probeGpu` now reads `window.__rendererInfo`. Never mint a context in a page you are measuring; still race `page.evaluate` against a timeout (`evaluateOrThrow`).
- A software rasterizer cannot reach the gate floor, so the frame-time arm needs an accelerated runner. Floors: `VEGETATION_FLOOR` 1000, `MIN_SAMPLES_FOR_ONE_PERCENT_LOW` 200.
- A vsync-locked p50 is a refresh divisor, not work; `frame-time-gate.mjs` unlocks rAF. Baselines are PER-VENDOR (another adapter's is refused); AMD has none, so the gate fails loudly. The orbit arm is a +-0.25 rad sine sweep, not a 360 deg spin, and must render >= 50% of the static arm's triangles.
- WebGPU `Info`: `info.render.calls` is CUMULATIVE and the only reliable liveness signal (`drawCalls`/`.triangles` read 0, no `info.render.frame`). TSL-vs-legacy parity, written BEFORE any frame: a region matches iff cross-renderer meanAbs/channel <= 3 x max(same-renderer noise floor, `QUANT_FLOOR` 1.0).
- Decide perf rows on counted work units: a ms-per-tick counter is not a measurement and a never-incremented counter a silent pass — before believing any zero, confirm the instrument's field exists on the measured backend (`vegProfile.meshInstances` read `LODinfo.render.count`, absent on `WebGPULodInstancer`, so every build read 0; `ee2e3baa`). Authoritative draw count = `perf-run.mjs drawsInstrument.authoritativeField` (`wgpuDrawsPerFrame`/`glDrawCallsPerFrame`).
- `prediction-drift-witness.mjs` is the diagnostic for "the client led the server": caps peak unacked (24), peak divergence (3 m), last 5 samples under `--settle-tol` (0.5 m); `--server-tick=<hz>` is the only lever that reaches them and that arm needs raised caps.
- CDP `Input.dispatchKeyEvent` reaches the app input bucket — read `window.__app.sentInput`/`sentInputCount`. `perf-run`'s `inputReachedGame` needs the held leg's movement bit true AND `sentInputCount` advanced (`1d34eecb`), so it is null for a held non-movement key; keyboard sets `input.backward`, never `input.back` (`InputHandler.js:160`). A walk witness measures accumulated path length, never net displacement; tps-game's player walks since `de8f378424`. `[physics] peak active 0` is NOT a stalled player: players are Jolt `CharacterVirtual`, which `GetNumActiveBodies()` never counts. `getLocalState().inputSequence` is undefined client-side, so `inputSequenceStart/End` stay null and `seqAdvanced` false.
- gm `exec_js` dispatches are ephemeral (a server booted in one is gone by the next). Use `127.0.0.1`, not `localhost` (~200 ms); snapshot bundles with `cp -p`.
- A headless Node witness constructing a `PhysicsNetworkClient` must polyfill `globalThis.WebSocket` from `ws`: Node 20 has no global WebSocket, so with it absent every multiplayer arm fails "only 0 of 2 client(s) joined" while the logic under test is healthy. Pre-change control: `scripts/.<name>.mjs` from gm `git_show {path, rev:"HEAD"}`.

## Security

- HiddenSpawn second-stage loader found and cleaned 2026-09-29 (`70cfe04f`): a `.env` plus 16 lines in `src/fluid/as-src/sph.ts`. Re-run the dependency scan on any fresh or updated `node_modules`.
- `SESCompartmentEvaluator.js` is the only untrusted-app evaluator and fails closed with no proxy tier; `StaticHandler` enforces path containment and COEP `require-corp`; `server-http-auth-matrix` holds the route/auth table. A failed `import('ses')`/lockdown throws `SandboxUnavailableError` (SANDBOX_UNAVAILABLE); first-party `apps/` never touch it.
- `authCompare.js timingSafeTokenEqual` self-compares (`bufA,bufA`) on a length mismatch so token length is not leaked — do not simplify it away.
- Benign exec surfaces, never flag as malware: `lang/spoint.js` (gm exec plugin), `mapspinner/planet.html` pollCmd eval, `scaffold.js` npx, `cdp-browser.mjs` curl relay.

@.gm/next-step.md
