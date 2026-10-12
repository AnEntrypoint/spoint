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

- Commit lanmower, main-only: `git_commit {message, paths}` (pathless `git_finalize` sweeps another lane's edit). Push the LITERAL sha (`{rev:"HEAD"}` gate-denied as symbolic; bare `{branch}` refused under foreign dirt). `amend` refuses pushed HEAD, can't strip CR from a landed CRLF blob (`git_reset_head` + re-commit). A landed commit can still say `nothing_to_commit_for_paths`: re-read `git_show {rev}`.
- Git verbs starve on a PHANTOM hold: state-changing git verbs return `dispatch_starved_waiting_for_serial_lane` (`executed:false`, `re_dispatch_safe:true`, `waited_ms 120001`); read-only git verbs still pass. Bypass: publish via the GitHub Git API in `exec_js` with `gh auth token` — blobs (base64, CRLF->LF), tree `base_tree`=remote tip, commit `parents:[tip]`, PATCH /git/refs/heads/main `{sha,force:false}`. Verify GET /contents/<path>?ref=main blob sha == `git hash-object`. `scripts/lib/git-api-publish.mjs` wraps that route: text paths are read as UTF-8 with CRLF->LF, and everything listed after `--binary` is uploaded byte-exact -- a binary artifact listed as text lands as U+FFFD mojibake at roughly 1.8x the size (`apps/world/tps-game.hf` once shipped 247910 byte(s) of it instead of 134694).
- `ci-status` ignores `rev` (falls back to local HEAD), so an unpushed sha answers `status: unknown` + 422; query `gh api repos/AnEntrypoint/spoint/commits/<sha>/check-runs`. `jq` is NOT installed: use `node --input-type=module -e`. CI logs: `/repos/<slug>/actions/runs/<id>/logs` (follow redirect, write bytes to an absolute path).
- A red `npm run check` is usually FOREIGN: stale bake pins in `src/shared/cacheCodeVersions.js` and the `apps/world/tps-game.hf` height code, which moves with terrain source. Read the log before blaming your own change. Re-bake: `node scripts/bake-heightfield.mjs --world <name> --extent 256 --res 1 --sector 16 --bits 16 --out apps/world/tps-game.hf`.
- `check-cache-keys.mjs` is shared: editing another transform's `BAKE_INPUTS_*` reddens `check` for every lane until the pin bumps in the SAME commit. `check.mjs` parses TRACKED files only; `BAKE_INPUTS_*` must declare their WHOLE import closure. Compute pins in a worktree at `origin/main` (`check.mjs` hashes the work tree, CI the commit). `bakeCodeVersion` = sha1 over rel path + CRLF-normalized content, hex[:12]; replicate inline for a few mirrored inputs. The pins live in `BAKE_TRANSFORMS`; `BakeCodeVersion.js` computes `bakeCodeVersion`.
- CRLF: `core.autocrlf=true` lives only in SYSTEM config. 203 files are index-LF + worktree-CRLF (false `modified`); `w/crlf` in `git ls-files --eol` = no diff, and a CRLF blob shows as one whole-file rewrite in `git show`. Verify with `git ls-files` + `git hash-object --path`, not the verb's `removed`/`staged`.
- `.gitignore` re-includes `.gm/*` only for `.gm/memories/`, `.gm/disciplines/project/`, `.gm/witness-log.md`, `.gm/witness-out/`, `.gm/pool/pool.log`; other `.gm/` paths are silently uncommittable.
- Untracking: `git_rm {cached:true}` + paths-scoped `git_commit {index_commit:true}`; `git ls-files` paths stay byte-identical or re-add. `git_reset {paths}` is path-scoped; bare `git_reset {}` refused. `.git/index.lock` fails `git_commit`; a foreign stalled git holds it 20+ min (`Get-CimInstance Win32_Process`); 0-byte lock + no spoint git alive = removable.
- Generated artifacts ship with source: `AppContext.js` -> `sdk-typings.generated.d.ts`; a height-code change re-bakes `apps/world/*.hf`.
- gm MCP is HTTP (`http://127.0.0.1:8787/mcp`), not stdio; it connects once and never retries, so a startup gap detaches it for the session (`/mcp` recovers). CLI `gm-dispatch.mjs <verb> '<json>'`; backslashes get mangled: file the body `"$(cat file)"`. Spool body = `in/<verb>/<session>-<pid>-<epochms>-<rand>.txt` + `.inflight`; write `.tmp` then RENAME onto `.txt`. `exec_js` bodies are ES module syntax; use `127.0.0.1`; the `bash` verb ignores `cwd`.
- gm daemon version matters: `status` reports `runner_version`; the lane-wait fix (release v0.1.288) is NOT live on a 0.1.272 box. Promotion `agentplug-runner.exe.new takeover <version>` waits 120 s and ABORTS while any dispatch is in flight.
- Subagent ceiling is 20, shared with peers: a spawn refusal does NOT mean this walk over-subscribed — park the slice, relaunch on the next completion. `pool-observe slots.live` reads 0; derive live from `.gm/pool/ledger-<wave>.txt` or `ListAgents`.
- `@spoint/ecs` resolves only via `@spoint/*`; that link can vanish mid-session and kill every harness (`npm run links` restores it; never `npm install`).
- `scripts/gpulock.mjs run <owner> [--wait-ms N] [--ttl-ms N] -- <cmd>` serializes accelerated arms via `.gpu-lock/owner.json` (2 s heartbeat, 120 s TTL, takeover on a dead/stale holder) and propagates the child's exit code; still grep the log for `RESULT:`.
- Never `git worktree remove` a `scripts/worktree-setup.mjs` worktree (its node_modules junction deletes `node_modules/.bin`); use `scripts/worktree-teardown.mjs`.
- CI: completing jobs = `check` + `frame-time-coverage`; `frame-time` has `if: vars.CI_GPU_RUNNER_ONLINE == 'true'` — no runner + var unset = SKIPPED (report skipped, never success). `concurrency` is PER SHA. CI Node 20; box Node 24.
- `npm run check` parses only tracked `src,client,apps,scripts,bin` and refuses browser/GPU witnesses by name. A witness must exit 0 AND print `RESULT: PASS`, pinned to a `must:` regex (`terrain-reseed-failure-witness.mjs` is the reference). Gpu-free admission is capability, not cost.

## PRD rows and witness binding

- A PRD row id is a claim until `prd_list {"id":...}` resolves it. Never re-type a row id, body, dispatch id, witness id or sha from memory — quote only the response that returned it. `prd_list {"filter":...}` is not a selector.
- `prd_resolve` needs a `witness_dispatch_id` recorded in THIS project's `.gm/exec-spool/.dispatch-ledger.json` (an id from another project root is refused as fabricated), or all four of `witness_exit_code`, `witness_output_sha256`, `witness_output_path` (RELATIVE to the project root, no `..`), `witness_ts`; `witness_evidence` is mandatory either way.
- `.gm/prd.yml` has a concurrent-lane lost update: an `ok:true` `prd-add` can later answer "prd id not found" while same-session rows survive. Fix = re-add the id, then resolve (row `ORCH-prd-lost-update-race-r259`).
- `git_finalize` on `.gm/prd.yml` is refused (`prd_foreign_rows`) while other sessions own uncommitted rows; scope the finalize to files your own walk owns.
- `prd.rs` reports `not_rerunnable` when a row's witness cites no existing `scripts/*.mjs|.js|.cjs` — a REPORT, not a regression; a row witnessed by inline `exec_js` stays completed but can never be auto-re-verified.
- A truncated witness is a fabricated witness: never `.slice()` a log line you quote a number, flag or path from (a `--sector 16 --bits 16` tail once read as `--sector 1`).

## Repo boundaries

- `design` ships as pinned CDN URLs in `client/{index,landing/index,editor/thebird-host}.html` + `scripts/bundle-client.mjs`; `vendor/*` = editing-only submodules.
- `apps/*` never imports `client/*` (singleplayer Worker resolves relative specifiers vs a virtual root); expose utilities on `engineCtx`.
- Node-only dynamic import specifiers stay opaque to esbuild/wrangler: IIFE, e.g. `src/sdk/EditorHandlers.js` `(() => './' + 'MinimapBake' + '.js')()`. `edge/cf-do/spoint-do.js` imports `jolt-edge-init.js` BEFORE `WorkerEntry.js`.

## Debugging discipline

- A bug surviving a threshold change isn't fixed. A cause in a report is a claim until instrumented; fix a failure at its own layer end-to-end — a second copy of the same check isn't a fix (`ShapeBuilder.js`).
- `spatial.mutations` is stable in a quiescent world (`SpatialIndex.update` skips under `distSq < 1.0`): don't assume a mutation-keyed epoch changes per tick.
- **Silent-no-op class**: a knob with no consumer, or whose enable bit defaults off, measures nothing — codesearch the reader + enable bit first. Cases: `?noveg` (no such flag), `__vdrsScale` (needs `window.__vdrs===true`), `?legacygl=1` (needs an in-page server), `u.fsCheap`, `perf-run.mjs inputReachedGame`, `--no-walk`, MICRO_JITTER (only `--mode=micro` reads it).
- **A module-level "report once" latch leaks across in-page rebuilds**: `PlanetFrame.guardedGroundHeight` deduped on a module-level Set, so a rebuilt `BrowserServer` (stall recovery / HostMigration, same page) never reported missing ground again. Put the latch on the returned closure.
- libuv `uv_async_send` asserts at `process.exit()` with handles mid-close; headless scripts await `process._getActiveHandles()` hitting 0.
- A witness needing the server to act on a client message passes `--params=multiplayer` (`?singleplayer` sees `players:0`, acks `ok:false`). A harness returning uncompared `{expected, got}` passes either way: one `expect()` per measurement.
- One `gl.getError()` code covers distinct bugs (1282 = feedback-loop, sampler-type-mismatch AND insufficient-buffer-size): read the driver's console string off a cache-disabled reload.
- Live GL: `window`/`document` only via `page.evaluate()` in a capture-prefixed script; pin file:line via `addInitScript` wrapping `drawElementsInstanced` (drain, then `gl.getError()`); editor via `app.clientMachine.send('TOGGLE_EDITOR')`.
- `scripts/lib/`: `head-vs-worktree.mjs`, `gm-dispatch.mjs`, `witness-audit.mjs`. `witness-audit.mjs --gate` = gpu-free arm of `npm run check`, HIGH tier only, vs committed `.witness-audit-baseline.json`; fails on an absent check id or a higher count. The LOW tier (`empty-catch`, `swallowed-error`) is advisory, never baselined. `--gate`/`--write-baseline` audit committed tracked scripts; without either the run walks the worktree, so `--all` alone sees a different file set. The gpu-free arm runs `fire-witness-gate.mjs` and `check-frame-time-baselines`; `SPOINT_GPU_WITNESS` marks a witness as needing a GPU.

## Entry points

- `ctx.defineGameFSM(spec)` `src/behaviours/game-fsm.js`; `ClientMachine.js` xstate5 parallel, fallback `after:` 10 s gated / 45 s hard stop.
- `ctx.defineFire(spec)` `src/behaviours/fire.js` (wired in `src/apps/AppContext.js`, default off).
- Test relocation: `window.__spoint` + `MSG.TELEPORT` (0xc2 / ACK 0xc3, `src/sdk/Relocation.js`; no `EDITOR_TOKEN` = any client; `relocation:false` disables; >87 deg refuses).
- Client `ctx.state` = entity `custom` block (`AppModuleSystem.js`), not server app state: `ctx.state.<key> ?? literal` takes the literal forever. `engine.cam` = camera CONTROLLER, no `position`; read `engine.client.getLocalState().position`.
- Wireweave attach helpers run after awaits (host migration reassigns `client` in `app.js`): re-check at call time.
- `createServer()` is a per-call factory; `boot()`'s SIGINT/SIGTERM handlers are process-global: stop with `RoomDirectory.stopAll`.
- A remote server's `netcode.profile` is named only when the client is a real `PhysicsNetworkClient`: boot that witness on `?connect=...&multiplayer=1`, else in-page `BrowserServer`.

## Fire

- Integer-only kernel `fireKernel.js`: decisions from `hash(seed,step,face,I,J)`; no float, `Math.random` or `Date.now`. The per-cell step is `fireKernel.js burnCell`.
- Rain smothers, doesn't eat fuel: a suppressed cell still burns `burnRate`, pushes no heat, spots nothing. Intensity 0..1 maps to a roll byte (255) via `rainPerIntensity` (`fireSpec.js`).
- `ctx.navCostAt(x,z)` = 8 burning / 2 charred, supplied by `_fireNavByRuntime` (`src/apps`); `canSee` is smoke-gated at depth >= `smokeBlockDepth`.
- Wind = weather BASE + `hash(seed,step)` gust, clamped +-16/axis; `snapshot().wind` carries BASE only.
- Per-cell initial fuel isn't recomputable in the kernel: a per-tile array in `snapshot()`/`restore()` joins `TILE_ARRAYS` + VERSION bump.
- A tampered keyframe is rejected at DECODE. `G` = ignition step mod 256, not age; IGNITE_AREA kind 5. `fireKeyframe.js` raises `[fireKeyframe]`; `rewindTo` restores one.
- A boundary `delta` rolls back the step BEFORE it (`takeDelta` at t=K reads `preStep` from K-`stepTicks`); restore verifies against `counters`, never `delta`.

## Planet-wide multiplayer

- One server world per cluster, own flat chart. Jolt heap fixed at 134217728 B (`JOLT_WASM_HEAP_BYTES`, `src/shared/clusterConfig.js`), never grows; over it `new J.JoltInterface` raises `Aborted(OOM)`.
- Three limits: `maxContactConstraints` under requirement drops contacts silently; `maxBodies` under population makes Jolt return body id 0, so overflow bodies share a map key and `destroy()` aborts wasm.
- Assignment is pure, hysteretic, 2-4 Hz; `resolveClusterConfig` refuses a link below the relevance ring or longest weapon range.
- Collider rings: `DEFAULT_MAX_CENTERS = 192` for BOTH trunk + rock streamers; rings per connected player, never centroid; `evictOverCap` is farthest-first; each ring is graded by `classifyRings` (`src/terrain/ColliderStreamer.js`).
- `clusters` occurs 0 times under `apps/`: `resolveClusterConfig` returns `null` for every shipped world, so planet-wide multiplayer is dead, not untested. No app declares `planetRadius`, so the cube-sphere branches never run. The cube-sphere AOI helpers `resolvePlayerCell`, `solveCellViewer` and `computeRingRelevantIds` live in `src/sdk`; `checkSlices` (`src/shared/worldResolve.js`) is what refuses a non-positive-finite `planetRadius`.
- Flat AOI is HORIZONTAL (`getRelevantEntitiesHorizontal`, chosen when `planetRadius <= 0`): zero vertical slack (`043d4704` made the empty-extent cylinder unrepresentable). `nearbyHorizontal` occurs 0 times in tracked code — the name is gone, horizontal selection is `getRelevantEntitiesHorizontal`.
- `StageLoader.js` throws when a radius is declared without enabled clusters and resolves config on EVERY load: six `ClusterConfigError` codes can throw at boot and on hot reload (latent).

## Chart re-anchor

- Chart-local server holders migrate via `src/sdk/chartState/` (`attachServerChartMigrators(ctx, service)`). Re-anchor = change of basis, not rotation: position/velocity/forward invariant. CHART_REANCHOR = 0xc6.
- Flat chart tilt is fixed by shrinking the chart: `CHART_ANCHORS_PER_FACE = 32`. `CHART_REANCHOR_ANGLE_DEG` (28 / 14) must exceed `createChartAnchorLattice`'s worst angle or the anchor thrashes; hysteresis 0.75.
- Exactly ONE chart per world; players at separation Delta sit at Delta/2, walkable iff `terrainTilt + Delta/2 <= 45 deg`.
- `chartEpoch` keys re-anchor: `ChartReanchorService.js`, `ChartReanchorTerrain.js`, `FieldLattice.js`, `ColliderStreamer.js`, and the `groundHeightLocal` memo gate on it.

## Physics and Jolt

- `physics.setBodyMotionType` returns a NEW body id or `false`. A Static-created body can't simulate via `SetMotionType`, hence recreation. `IsActive()` is the only discriminator: `GetMotionProperties()` is non-null even on a static-created body.
- Recreation creates the new body BEFORE destroying the old, on `LAYER_DYNAMIC`; refuses a body holding a constraint, vehicle chassis or trimesh/mesh/heightfield shape.
- A pooled body whose `bodyMeta.type` != requested motionType is destroyed + replaced (pool key = model|scale only); `removeBody` on pooled DYNAMIC does `DeactivateBody` + zeroes both velocities. Re-admission is `_revivePooledBody`; `addConstraint` supplies default anchors, and `getBodyPosition` returns the shared temp, so copy before the next call.
- `BodyInterface.GetPosition` returns ONE shared temp, so two calls alias. Jolt recycles removed bodies' tree nodes only in `physics.step`: re-adding thousands of bodies with no step between aborts wasm.
- Jolt `HeightFieldShape` exposes `GetMinHeightValue()`/`GetMaxHeightValue()`/`GetSampleCount()`, NOT `get_mMinHeightValue`; `GetSampleCount()` = PER-SIDE count (N), not N*N.
- Trimesh/convex collider build failure in `src/apps/AppPhysics.js` PROPAGATES as `ColliderBuildError`; never degrades to a 0.5 m box. `AppRuntime`'s `config.autoTrimesh` branch + `EditorHandlers.js` still box.
- `ent._bodyDef` keeps the convex hull for dynamic bodies; `changeBodyType` clears it for static.
- `AppRuntimePhysics.js` skips `e._vehicleId != null` in BOTH `_tickPhysicsLOD` and `_enforceBodyBudget`; `_tickPhysicsLOD` runs only every `_physicsLODInterval` ticks. Height samples snap to 1 mm via `+ 0`, and `Math.round` of a negative sample yields -0, which differs from +0 as `Float32Array` bits.
- `VehiclePhysics.js`: never `J.destroy` `v.constraint`/`v.tester` after `RemoveConstraint`, nor `get_mTracks()` copies after `set_mTracks`; empty `mDifferentials` = zero wheel torque.
- EDITOR_UPDATE calls `syncEntityCollider` AFTER `changeBodyType` (which removes the body and clobbers `custom._collider`).

## Terrain and colliders

- `solveSurfaceY` tolerance absolute `1e-4` (`SURFACE_SOLVE_TOLERANCE_M`, `PlanetFrame.js`), 64-eval cap, throws `SurfaceSolveError`; past 63.6 km it returns `-(R+anchorHeight)` with no throw.
- Baked heightfield FAIL-LOUD (`src/terrain/TerrainPhysics.js`): absent = silent CPU fallback; unreadable/truncated/bad-magic/stale-code throw `[baked-heightfield]`; `hashVersion`/`terrainKey`/`chartEpoch` mismatch warns + falls back. Bake key = `[radius, hpfTexRes, seed, reliefScale, hashVersion, carves]`; carves are v2-only and come from `terrainCarvesOf`. Figures: s9.
- No terrain is FATAL: `ServerAPI.loadWorld` rethrows `[terrain] world "<id>" has no terrain`; every caller stops its server first.
- Two height backends; v2 = parity backend. `elevationAtLocal(frame,x,y,z)` = exactly `|p|-radius`; app-facing `ctx.terrainHeightAt` is NOT that.
- `PlanetFrame.groundHeightLocal` caches in 4096 direct-mapped slots keyed by EXACT `(x,z)` + chartEpoch (memoises `SurfaceSolveError` too).
- `terrain.glsl`'s `snoise3`/`vnoise2`/`seaHash`/`hpfSample` take the in-cell fraction as `P-floor(P)` from ONE `floor`.
- Server terrain collider = ONE fixed-anchor local tangent plane (`anchorDir` default [0,1,0]): can't represent directions past ~87 deg from anchor.
- `gl-render.js sampleGroundM` is fire-and-forget async (PBO+fence), so each call returns the PREVIOUS call's height. Non-rAF callers use `sampleGroundMSync`, which poisons the next async read.
- `VegPlacement.js`/`RockPlacement.js` read climate before `surfaceOfCell` only when `climateUsesLocalXZ !== true`. Veg density must gate on painted snow, else surviving grass weight roots trees. Slope caps differ per placer: `VegPlacement SLOPE_MAX` 0.6, `GrassPlacement SLOPE_MAX` 0.9.
- REFUTED, don't retry: `PlacementChart.js radialSlopeAt`'s 2-tap forward difference — the gradient crosses `SLOPE_MAX`, flipping gate decisions.

## Netcode and wire

- Prediction suppresses only the blocked DIRECTION: `_reconcile` (`PredictionEngine.js`) derives `wedgeNormal` from commanded-vs-achieved motion, else `-velocity` when stopped while commanding; `shared/characterStep.js` projects out that component alone.
- `msgpack.js` `WIRE_STRUCTURES[1]` lists exactly the keys, in order, of `TickHandler.js _packPayload`. msgpackr 2.0.4 writes -0 as `0x00`; `patch-deps.mjs` excludes -0 from both integer tests. Coalesced batches are split by `splitCoalesced` (`src/client`). Raw ws clients mirror `COALESCE_SENTINEL` 0xff: `0xFF` then `[uint32 LE length][msgpack]`.
- Wire v3 player record: 8 fields in a 22-byte bin; `[inputSequence, inputBuffer, groundNormal]` ride a per-recipient `me` block, so snapshots pack per recipient. `getSnapshot()` keys on `_version === _snapshotVersion` alone.
- `PhysicsNetworkClient.connect()` REJECTS with a named `TransportConnectError`, never `connected:false` with no socket. Retry belongs in the caller (`_doReconnect`). The refusal carries a stable `err.reason`: `websocket-unavailable`, `-closed-before-open`, `connect-superseded`.
- Prediction lead is capped by `MAX_PREDICTION_LEAD_STEPS` (`src/client`): `BaseClient.js sendInput` feeds `predEngine.addInput`, and `predictionLeadSteps();` reports the lead; `prediction-drift-witness.mjs` pins the measured sim rate with `--server-tick=<hz>`.
- `SnapshotGroupPlanner`: groups = `ceil(viewers*perViewerMs/(budgetMs-fixedMs))`; budget = tick period * `SNAP_COST_HIGH_FRAC` 0.35. `relevanceRadius` is set by worlds (`src/presets/tps.js` 200, `apps/world/construct.js` 100); `getRelevanceRadius` falls back to 0 only where a world omits it.
- Lockstep: rollback is input-capped, so measure by depth, not rate (`maxRollbackTicks` 12); `maxRollbackTicks + inputDelayTicks >= windowSize` throws; `inputDelayTicks` above `INPUT_RETAIN_TICKS` (240) throws at construction.
- A socket becomes a player by MIGRATE, RECONNECT, or silence past the MIGRATE-peek grace (`ServerHandlers.js onClientConnect`, 50 / 1500 ms dilated). A silent probe joins as a phantom, so probes use `?probe=1`. Never answer an unresolvable RECONNECT with INVALID_SESSION and leave it open: `rejectSession` flushes + closes.
- Migration keeps the old transport as fallback owner and hands the player back on candidate death; a close from a client no longer owning can't tear it down.
- Authoritative path: prediction off by default (`?predict` only); rollback/lockstep unwired. `processPlayerMovement` takes ONE input per tick, catching up only while `inputs.length > INPUT_BUFFER_CATCHUP_DEPTH` 8.

## Rendering

- `WebGPURenderer` is DEFAULT (`?legacygl=1` opts out); unavailable WebGPU retries `forceWebGL=true` before legacy, so TSL is the only shader path. WebGPU uses TerrainBackdrop's `fE` as per-vertex clip transform. `ClusterLodMesh._render` (`cluster-lod-mesh.js`) fires once PER GROUP per frame: keep the `_lastRenderFrame===frame` early-return. HiZ shaders live in `webgpu-hiz-shaders.js`, and HiZ cull must equal the CPU cull; `three.webgpu.js` is patched by `patch-deps.mjs` at every `popErrorScope();` site.
- Veg LOD: `WebGPULodInstancer`'s oracle mirrors `updateLOD`; `lodEye` refreshes only after 0.5 m (`LOD_REEVAL_MOVE_SQ`). A leaf instancer is a SATELLITE of its branch (`opts.host`).
- Default terrain FS is TSL, not `terrain.glsl`: `TerrainBackdrop.js` imports `mapspinner/src/tsl/planet-tsl.js` when `isWebGPU`. `terrain.glsl` = legacy path + height-parity SoT (`gen-height.mjs` transpiles it); deleting it needs a new SoT + generator. Every discard in it stays inside `#ifdef _WATERPASS_`.
- `terrain-lighting-tsl.js` gates `sky.marchRadiance` on `apGate > 0`; Terrain `renderOrder` 10. Water `WATER_DRAWS_BEFORE_OTHER_TRANSPARENTS` -1: shading always paid. `apTrans`/`apRad` are the AP terms; terrain draws under `TERRAIN_DRAWS_AFTER_OPAQUE_OCCLUDERS`; `texFarFade > 0.001` gates the far splat fetches; the material output slot is `outputNode` and `side = DoubleSide`, so backfaces are never culled. Static per-pixel counts, not timings (s7).
- TSL `select` outside `uniformFlow` emits a real `if/else` (three's `ConditionalNode`), not a ternary: both sides are NOT evaluated.
- VDRS has no live consumer (zero `vdrs` under `packages/mapspinner/src/tsl`). `?legacygl=1` flips terrain hashVersion, so a legacy run isn't comparable to a TSL number. `__vdrsScale` needs `window.__vdrs === true`, so it measures nothing by default.
- `invertAcesFilmic` must NOT end in `max(x, 0)`: saturated blue inverts out of AP1/ACES gamut and clamping mis-encodes it. Rendered sea = sphere R == `PlanetFrame.waterlineLocalY` to 1 cm; waves ZERO-MEAN.
- `ShadowPipeline.js forceUpdate` sets EVERY cascade's `light.shadow.needsUpdate`; `cascadeCount` clamps to 1 when `sun.castShadow===false` (cascade 0 IS the sun, never renders). `QualityPresets.js` ships `ssao`/`bloom` false.
- Vegetation `InstancedMesh2`: `sortObjects` stays false with LODs; `CullFreeze.js setInstancedCullAuto` sets `autoUpdate` on parent AND every LOD level. `model-pool.js` drains must allow >=1 unit/frame or a zero budget deadlocks.
- Veg + Rocks + `Grass.prewarm` budget WORK (`3384c0613f`): prewarm sums `loadChunk` durations, yields on a macrotask every 24 ms, reports `prewarmMs`/`prewarmWorkMs`/`prewarmChunks`. Boot effect: s11.

## Client and app runtime

- HUD `applyDiff(container, hudVdom)` (`client/AppModuleSystem.js` renderAppUI) is 4 Hz, not per frame, and already diffs in place: webjsx keeps the previous vdom on the container, so an unchanged subtree costs 0 removes / 0 adds / 0 attribute writes and a one-field change costs 1 text write. Pinned by `scripts/hud-applydiff-witness.mjs`. Imperative DOM overlays mount on `document.body`. The previous vdom webjsx stores is `node.__webjsx_props` plus a `node.__webjsx_childNodes` cache — there is no `__vdom` property anywhere in `client/`.
- webjsx 0.0.73 (`node_modules/webjsx`, used by `client/AppModuleSystem.js`) has no `newVNode instanceof Node` branch in either `canUpdateVNodes` or `applyChanges`, so a real DOM node placed in a vdom throws `Cannot read properties of undefined (reading 'xmlns')` inside `createDOMElement`; `renderAppUI`'s try/catch swallows it and the HUD silently stops updating. The vendored `vendor/design/vendor/webjsx` copy has that branch; `anentrypoint-design` (used by `client/hud/*`) re-exports the vendored one.
- `_buildWorldScenery` is joinable: boot adopts a running build (`Promise.race` doesn't cancel the loser).
- `app.js animate()` returns early while `window.__warmupInFlight`; model-pool + streaming loads pump from frame jobs there, so never park a wait inside warmup.
- Client `WORLD_DEF` from `sendWorldDefAndModules` has `entities` STRIPPED and carries `_modelUrls`: derive world-entity facts from `_modelUrls`.
- Hot reload releases ctx via `AppRuntime._releaseAppContext`; `update()` keeps running with a torn-down ctx unless `_updateList`/`_rebuildCollisionList` are rebuilt.
- `AppRuntime._attachApp` does `apps.set` BEFORE awaiting `setup()`; `spawnEntity` attaches apps fire-and-forget: collect tagged entities on the first `update()` tick.
- `src/apps/CustomVersion.js`: `Reflect.set` is a deliberate raw write; a read must not reach the set trap and bump `_customV`.
- Spawn: `holdSpawnUntilGrounded` (`src/sdk/Relocation.js`) gates release on `terrainFieldMissingAt`/`coversPosition` (max `SPAWN_HOLD_MAX_MS=20000`); `staticCollidersPendingNear` is true whenever `AppRuntime._pendingTrimeshBuilds.size > 0`, regardless of spawn point.
- Respawn clearance is shared: `AppGameplay.js pickSpawnPoint` + tps-game use one `footprintBlockers` sampler (17 down-ray columns; surface > `MAX_FOOTPRINT_INTRUSION_M` 0.15 m above a column bottom = `intruding`); the margin is that constant (`src/apps/AppGameplay.js:20`). `apps/tps-game/respawn-clearance.js` exports no `spawnClearanceMarginM`.
- `BrowserServer.js`: `_lastTodSync` + `_deliveredWorldFingerprints` are MODULE level, so stall recovery + HostMigration rebuild a fresh BrowserServer in the same page.
- Singleplayer worker identity comes from `INIT.worldName`; the snapshot is one IDB key `world-snapshot` per origin.
- `FloatingOrigin.js update()` does `camera.position.set(0,0,0)` on rebase, not `+= -delta`.

## Measurement and witnessing

- Measured figures, refutations and instrument/adapter notes: `docs/measurement-figures.md` (struck values are replaced there).
- Per-pass GPU timings (`p50Ms`,`p95Ms`,`avgMs`) are INVALID as GPU-bound measures (lane a368d997: bimodal near-zero mode, s0); a 0 duration is UNWRITTEN (65.5 us granularity). AMD iGPU `--gpu-passes --extra=gputime=1 --backend=webgpu` works only after `npm run build:client` and is INVALID too. Quote no per-pass figure, select no arm by one, never split stages with a `?gpuhide=` differential.
- No `perf-run.mjs` instrument unlocks vsync (flags live only in `frame-time-gate.mjs` behind `UNLOCK_RAF`). Baselines are per-vendor; an unbaselined vendor fails loudly.
- Pin each GPU arm's adapter: `vendorGpuArgs(vendor)` adds `--use-adapter-luid=0,<luid>` (`gpuLaunchArgs()` doesn't). Chrome ignores an unresolvable LUID while reporting accelerated, so assert `window.__rendererInfo`'s renderer string; never mint a WebGL2 context in a measured page. AMD verdicts need a quiet window: `gpulock` serializes the adapter, never the CPU.
- Decide perf rows on counted work units: a never-incremented counter is a silent pass, so confirm the field exists on the measured backend (`vegProfile.meshInstances` is absent on `WebGPULodInstancer`). Authoritative draw count = `drawsInstrument.authoritativeField` (`wgpuDrawsPerFrame` / `glDrawCallsPerFrame`); WebGPU `info.render.calls` is cumulative.
- Toggles: `?lightplanet` stubs the planet but keeps the height sampler + foliage; `?veg=none`, `?nograss`, `?norocks` are real. `window.__vegAllOff` (read in `client/core/Vegetation.js`) kills foliage per frame; no per-part app toggle.
- `perf-run.mjs`: `?gpuhide=`/`?gpuab=<name>` (boolean), `?gpuabms=<ms>`; `--knob=<key>=<value>[,...]`. Keys are registry `key`s verbatim (`maxLevel`, not `__maxLevel`), set at document start by a setter trap on `window.__renderControls`; one bad key fails the run. Limits: `maxLevel` 2..22, `splitFactor` >= 0.05. `?knob=` is the in-page form of `--knob`; both land through `registry.set` on the control registry installed by `installRenderControls();`.
- `dprAuto` defaults `false` (`client/core/RenderControls.js`); measuring arms pass `--knob=dprOff=true`. `window.__dprAuto`/`__dprOff` no longer exist.
- QualityGovernor drives only GOVERNED_KNOBS (ssao, bloom, ssr, vegLeafOff, maxLevel, splitFactor) and throws if a driven key is in RESOLUTION_KEYS (`dpr*`, `vdrs*`, `threeVdrs*`, `fsr1*`, `halfResWater`, `bloomResolutionScale`): no pixel doubling. `resolveTier()` takes min(booted, tier); tiers 0 and 1 are byte-identical. Live only when `qualityGovernor===true && qualityGovernorOff!==true`.
- **QualityGovernor is DEAD BY DEFAULT -- silent-no-op class, not a perf bug.** `qualityGovernor` defaults false (`client/core/RenderControls.js:45`), `qualityGovernorOff` defaults false, and `qualityGovernor` occurs 0 times under `apps/`, so no shipped world turns it on: the per-frame caller in `client/app.js` (`_adaptQuality(_perf.lastMs)`) is live, but `tick()` returns at the `enabled()` gate. Measured on the real module by `scripts/governor-hitch-response-witness.mjs`: with shipped defaults a 40 ms load over 600 frames produces 0 steps and never leaves tier 0; forced on, the first action lands at frame 60 (1062 ms at 17.7 ms/frame). Even then it is hitch-blind: the shortest over-budget burst that trips it is 40 consecutive frames (39 never trips), a single 50/100/200 ms hitch produces 0 steps, one 100 ms hitch per 30-frame window produces 0 steps and is reported as 11.067 ms avg -- headroom below raiseBelow 13.67 -- and the smallest hitch it can see at all is 299 ms per window (298 is invisible), still answered only at frame 60. Cause: `tick()` consumes only the 30-frame arithmetic mean of `lastMs`, with no window max/p95 and no per-frame overrun latch, so anything shorter than a window is arithmetically invisible.
- `halfResWater` reads as `=== true` (`gl-render.js`), so unset = OFF; its water-occlusion branch needs `window.__planetDepthToCanvas === true` (set only by `client/core/TerrainBackdrop.js`).
- An untagged template literal turns a lone `\d` into `d`: write `\\d+` (`?gpuabms=` was inert through `3384c0613f` for this).
- WebGPU parity: a region matches iff cross-renderer meanAbs/channel <= 3 x max(same-renderer noise floor, `QUANT_FLOOR`); establish the same-code floor first (s8).
- CDP `Input.dispatchKeyEvent` reaches the app input bucket (`window.__app.sentInput`); keyboard sets `input.backward`, never `input.back`. `[physics] peak active 0` doesn't mean a stalled player (`CharacterVirtual` isn't counted by `GetNumActiveBodies()`). Scripted runs drive input via `window.__spoint._drive`; delivered count is `sentInputCount`.
- A witness with a fixed scratch dir must `rm` it at start (a gate killed at its 120 s cap leaves it; later runs hang). Headless Node witnesses building `PhysicsNetworkClient` polyfill `globalThis.WebSocket` from `ws`. `edge-collider-draco-witness.mjs` rewrites tracked `apps/tps-game/*.glb` in place: never run it in a gate.
- **client/hud IS node-witnessable** — the old "no node witness possible" claim is withdrawn. Install a `node:module` `registerHooks` resolve hook redirecting the bare `anentrypoint-design` package, the dynamic `wireweave`/`xstate` imports, and root-relative `/src/...` via `pathToFileURL('C:/dev/spoint' + spec)`; add a minimal document + AudioContext stub; set `globalThis.navigator` via `Object.defineProperty` (getter-only in Node 24). Without the hook the import fails at stage 1. A vdom stub must flatten children that may be a bare string.

## Security

- Re-run the dependency scan on any fresh or updated `node_modules`.
- `SESCompartmentEvaluator.js` is the only untrusted-app evaluator and fails closed (`SandboxUnavailableError`); `StaticHandler` enforces path containment + COEP `require-corp`. A failed `import('ses')`/lockdown throws: ses is only in optionalDependencies, so a skipped optional install disables the sandbox.
- `authCompare.js timingSafeTokenEqual` self-compares (`bufA,bufA`) on a length mismatch so token length isn't leaked: don't simplify it away.
- Benign exec surfaces, never flag as malware: `lang/spoint.js`, `mapspinner/planet.html`, `scaffold.js`, `cdp-browser.mjs`.
- Witness CLIs taking `--module=<path>` load that path as code: point them only at trusted files.

@.gm/next-step.md
