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

`sN` = section N of `docs/measurement-figures.md` (s0..s14). Cite `path` + symbol, never line numbers: `scripts/agents-md-facts-witness.mjs` re-checks every path claim here.

## Working rules

- Commit lanmower, main-only, no trailers; `git_commit {message, paths}` (a pathless `git_finalize` sweeps another lane); push the LITERAL sha.
- A path-scoped publish is NOT content-scoped: content comes from the shared work tree and sweeps neighbours' edits — name paths AND verify the blob.
- Git verbs starve on a PHANTOM hold: state-changing ones answer `dispatch_starved_waiting_for_serial_lane` at a fixed 240 s budget (read-only pass); bypass via `git-api-publish.mjs`.
- "Modified vs local HEAD" != contested: local HEAD lags remote main — compare the worktree blob to REMOTE main (`GET /contents/<path>?ref=main`).
- `ci-status` ignores `rev`: an unpushed sha answers `unknown` + 422; query `gh api .../commits/<sha>/check-runs`.
- A red `npm run check` is usually FOREIGN (stale bake pins): read the failing line first; re-bake `bake-heightfield.mjs --extent 256 --res 1 --sector 16 --bits 16`.
- `check-cache-keys.mjs` is shared: editing another transform's `BAKE_INPUTS_*` reddens `check` for every lane until the pin bumps in the SAME commit. Compute a pin from REMOTE blobs, reproducing the existing pin first.
- `scripts/check.mjs` parses TRACKED `src,client,apps,scripts,bin` and runs EVERY gpu-free witness, printing `all <n> ran` plus the failing names. A witness must exit 0 AND print `RESULT: PASS`; one NOT in the gpu-free arm never runs.
- An absolute Windows path (`C:/dev/spoint/...`) in `scripts/*` is a CI-only ENOENT on ubuntu: resolve paths relative to the repo root.
- CI: completing jobs = `check` + `frame-time-coverage`; `frame-time` needs `vars.CI_GPU_RUNNER_ONLINE == 'true'` (else SKIPPED). Judge the newest CI-evaluated commit: `check-runs` on a `[skip ci]` bump is zero and reads as pass.
- Generated artifacts ship with source: `AppContext.js` -> `client/editor/sdk-typings.generated.d.ts` from the AppContext import closure; a pre-commit hook refuses a closure change without it.
- gm MCP is HTTP on `127.0.0.1:8787/mcp` and never retries: a startup gap detaches it (`/mcp` recovers).
- Never `git worktree remove` a `worktree-setup.mjs` worktree (its node_modules junction deletes `node_modules/.bin`); use `worktree-teardown.mjs`.

## PRD rows and witness binding

- A PRD row id is a claim until `prd_list {"id":...}` resolves it. Never re-type a row id, body, dispatch id, witness id or sha. Row ids collide across sibling sessions, so a `prd-add` can overwrite another lane's row.
- `prd_resolve` needs a `witness_dispatch_id` in THIS project's `.gm/exec-spool/.dispatch-ledger.json`, or all four of `witness_exit_code`, `witness_output_sha256`, `witness_output_path` (RELATIVE to the root), `witness_ts`.
- `.gm/prd.yml` has a concurrent-lane lost update: an `ok:true` `prd-add` can later answer "prd id not found" — re-add the id, then resolve. `git_finalize` on it is refused (`prd_foreign_rows`) while other sessions own rows.
- `prd.rs` reports `not_rerunnable` when a row's witness cites no existing `scripts/*.mjs|.js|.cjs` — a REPORT, not a regression; an inline-`exec_js` row stays completed but can never be re-verified.
- A truncated witness is a fabricated witness: never `.slice()` a log line you quote a number, flag or path from.

## Repo boundaries

- `design` ships as pinned CDN URLs in `client/{index,landing/index,editor/thebird-host}.html` + `bundle-client.mjs`; `vendor/*` = editing-only submodules.
- `apps/*` never imports `client/*` (the singleplayer Worker resolves relative specifiers vs a virtual root); expose utilities on `engineCtx`. `apps/world/index.js` is the default-world authority.
- Node-only dynamic import specifiers stay opaque to esbuild/wrangler: IIFE, e.g. `EditorHandlers.js`. `edge/cf-do/spoint-do.js` imports `jolt-edge-init.js` BEFORE `WorkerEntry.js`.

## Debugging discipline

- Fix at the failing layer end-to-end — a second copy of the same check isn't a fix (`ShapeBuilder.js`); a bug surviving a threshold change isn't fixed.
- **Silent-no-op class**: codesearch the reader + enable bit first. Cases: `?noveg`, `__vdrsScale` (needs `window.__vdrs===true`), `?legacygl=1`, `u.fsCheap`, `inputReachedGame`, MICRO_JITTER. REFUTED: `--no-walk` — reader is `const WALK = !has('no-walk')`, which empties the movement legs.
- **Silent-default class**: `Number.isFinite(x) && x > 0 ? x : literal` and `v ?? DEFAULT` turn invalid input into the default. Parse the whole record at ONE boundary and refuse there (`ColliderStreamer.js`, `stageShapes.js`). `typeof v === 'number'` admits `1e999`.
- **No sentinel for absence**: "no ground" is a rejected variant (thrown `NoGroundHeightError`), never 0 or NaN; `null` compares as 0, so land paints at sea level. `guardedGroundHeight(where, heightFn)` takes TWO args.
- **Refusals carry a code, not prose**: `createClusterAssigner`, `assertWorld`, `StageLoader` (`StageConfigError.reasonCode`), `TickHandlerAOI` (`position|noPosition|unknownEntity`).
- **A module-level "report once" latch leaks across in-page rebuilds**: `PlanetFrame.guardedGroundHeight` deduped on a module-level Set, so a rebuilt `BrowserServer` never reported missing ground again. Put the latch on the returned closure.
- **A witness that mints ids as strings never reaches the parse boundary and pins nothing** — mint integers. A fixture that never stamps a sender fails every `handle()`, since `senderOf` reads the symbol `stampSender` writes.
- **A bare CLI flag parses to the string `'true'`**, so `Number()` yields NaN and disables the knob it sets.
- A witness needing the server to act on a client message passes `--params=multiplayer` (`?singleplayer` sees `players:0`). One `expect()` per measurement: a harness returning uncompared `{expected, got}` passes either way.
- One `gl.getError()` code covers distinct bugs (1282 = feedback-loop, sampler-type-mismatch AND insufficient-buffer-size): read the driver's console string. Live GL: `window`/`document` only via `page.evaluate()`; pin file:line via `addInitScript`.
- `witness-audit.mjs --gate` is the gpu-free arm of `npm run check`, HIGH tier only, vs committed `.witness-audit-baseline.json`; fails on an absent check id or a higher count. LOW tier (`empty-catch`, `swallowed-error`) is advisory.

## Entry points

- `ctx.defineGameFSM(spec)` `src/behaviours/game-fsm.js`; `client/core/ClientMachine.js` xstate5 parallel. `ctx.defineFire(spec)` `src/behaviours/fire.js` (wired in `AppContext.js`, default off).
- Test relocation: `window.__spoint` + `MSG.TELEPORT` (0xc2 / ACK 0xc3, `src/sdk/Relocation.js`); >87 deg refuses.
- Client `ctx.state` is the entity `custom` block (`AppModuleSystem.js`), not server app state: `ctx.state.<key> ?? literal` takes the literal forever. `engine.cam` is the camera CONTROLLER (no `position`); read `engine.client.getLocalState().position`.
- Wireweave attach helpers run after awaits (host migration reassigns `client` in `app.js`): re-check at call time. `createServer()` is a per-call factory; `boot()`'s signals are process-global — stop with `RoomDirectory.stopAll`.
- A remote server's `netcode.profile` is named only when the client is a real `PhysicsNetworkClient`: boot that witness on `?connect=...&multiplayer=1`, else in-page `BrowserServer`.

## Fire

- Integer-only kernel `fireKernel.js`: decisions from `hash(seed,step,face,I,J)`; no float, `Math.random` or `Date.now`. Per-cell step = `burnCell`.
- Rain smothers, doesn't eat fuel: a suppressed cell still burns `burnRate`, pushes no heat, spots nothing. Intensity 0..1 -> roll byte 255 via `rainPerIntensity` (`fireSpec.js`).
- `ctx.navCostAt(x,z)` = 8 burning / 2 charred (`_fireNavByRuntime`); `canSee` is smoke-gated at depth >= `smokeBlockDepth`. Wind = weather BASE + `hash(seed,step)` gust, clamped +-16/axis; `snapshot().wind` carries BASE only.
- Per-cell initial fuel isn't recomputable in the kernel: a per-tile array in `snapshot()`/`restore()` joins `TILE_ARRAYS` + VERSION bump.
- A tampered keyframe is rejected at DECODE. `G` = ignition step mod 256, not age; IGNITE_AREA kind 5. `fireKeyframe.js` raises `[fireKeyframe]`; `rewindTo` restores one and verifies against `counters`, never `delta`, which at a boundary rolls back the step BEFORE it.
- A fire record promising work with no sampler is refused at construction (`src/behaviours/fireTerrain.js`): `firebreaks.kinds` defaults `['road','river']` while `kindAt` is null; `firebreaks.water` defaults true while `heightAt`/`seaLevelAt` are null.

## Planet-wide multiplayer

- One server world per cluster, own flat chart. The Jolt heap is fixed at 134217728 B (`JOLT_WASM_HEAP_BYTES`, `src/shared/clusterConfig.js`) and never grows; over it `new J.JoltInterface` raises `Aborted(OOM)`.
- `maxContactConstraints` under requirement drops contacts silently; `maxBodies` under population makes Jolt return body id 0, so overflow bodies share a map key and `destroy()` aborts wasm. Assignment is pure, hysteretic, 2-4 Hz.
- Collider rings: `DEFAULT_MAX_CENTERS = 192` for BOTH trunk + rock streamers; rings are per connected player, never centroid; eviction farthest-first, graded by `classifyRings` (`ColliderStreamer.js`).
- Clusters are OFF in every shipped world (`tps-game.js`, `tutorial.js` declare `clusters: { enabled: false }`); the world-def parser makes the mismatch unrepresentable both ways and refuses `terrain: true` (`worldDefParse` vs `resolveTerrainConfig` read it oppositely).
- Flat AOI is HORIZONTAL (`getRelevantEntitiesHorizontal`, chosen when `planetRadius <= 0`): zero vertical slack.
- `StageLoader.js` resolves cluster config on EVERY load and throws when a radius is declared without enabled clusters: six `ClusterConfigError` codes throw at boot and hot reload.

## Chart re-anchor

- Chart-local server holders migrate via `src/sdk/chartState/` (`attachServerChartMigrators(ctx, service)`). Re-anchor is a change of basis, not a rotation: position/velocity/forward invariant. CHART_REANCHOR = 0xc6.
- Flat chart tilt is fixed by shrinking the chart: `CHART_ANCHORS_PER_FACE = 32`. `CHART_REANCHOR_ANGLE_DEG` (28) must exceed `createChartAnchorLattice`'s worst angle (~2.26 deg) or the anchor thrashes. ONE chart per world; separation Delta puts players at Delta/2 (walkable iff `terrainTilt + Delta/2 <= 45 deg`).
- `chartEpoch` keys re-anchor: `ChartReanchorService.js`, `ChartReanchorTerrain.js`, `FieldLattice.js`, `ColliderStreamer.js`, `groundHeightLocal` memo.

## Physics and Jolt

- `physics.setBodyMotionType` returns a NEW body id or `false`. A Static-created body can't simulate via `SetMotionType`, hence recreation. `IsActive()` is the only discriminator: `GetMotionProperties()` is non-null even on a static-created body.
- Recreation creates the new body BEFORE destroying the old, on `LAYER_DYNAMIC`; it refuses a body holding a constraint, vehicle chassis or trimesh/mesh/heightfield shape.
- A pooled body whose `bodyMeta.type` != requested motionType is destroyed + replaced (pool key = model|scale only). `getBodyPosition` returns the shared temp: copy before the next call. Jolt recycles removed bodies' tree nodes only in `physics.step`.
- Jolt `HeightFieldShape` exposes `GetMinHeightValue()`/`GetMaxHeightValue()`/`GetSampleCount()`, NOT `get_mMinHeightValue`; `GetSampleCount()` is the PER-SIDE count (N), not N*N.
- Trimesh/convex collider build failure in `src/apps/AppPhysics.js` PROPAGATES as `ColliderBuildError`, never degrading to a 0.5 m box; `AppRuntime`'s `config.autoTrimesh` branch + `EditorHandlers.js` still box. `changeBodyType` clears `ent._bodyDef` for static.
- `AppRuntimePhysics.js` skips `e._vehicleId != null` in BOTH `_tickPhysicsLOD` and `_enforceBodyBudget`; the sweep runs only every `_physicsLODInterval` ticks. `Math.round` of a negative height sample yields -0, which differs from +0 as `Float32Array` bits.
- `VehiclePhysics.js`: never `J.destroy` `v.constraint`/`v.tester` after `RemoveConstraint`, nor `get_mTracks()` copies after `set_mTracks`; empty `mDifferentials` = zero wheel torque.
- EDITOR_UPDATE calls `syncEntityCollider` AFTER `changeBodyType` (which removes the body and clobbers `custom._collider`). A force no body ever received must not become entity velocity — `runtime.applyImpulseToEntity` answers `false` for exactly that.

## Terrain and colliders

- `solveSurfaceY` tolerance is absolute `1e-4` (`SURFACE_SOLVE_TOLERANCE_M`, `PlanetFrame.js`), 64-eval cap, throws `SurfaceSolveError`; outside the chart (`x*x+z*z >= radius*radius`) it throws `ChartRangeError`.
- **A sampled vertex height must be a function of the vertex, not of the walk**: `sampleTerrainGridChunked` was seeded each solve from `prev + (prev - prev2)`, and the 1 mm `HEIGHT_SNAP_PER_METRE` is 10x coarser than the 1e-4 tolerance (0.000142 m vs 0.001000 m). Fix: start every solve from `renderYOnSphere(r2, 0)` (`HeightfieldStreamer.js`). REFUTED too: 16-bit field quantization.
- Baked heightfield FAIL-LOUD (`TerrainPhysics.js`): absent = silent CPU fallback; unreadable/truncated/bad-magic/stale-code throw `[baked-heightfield]`; `hashVersion`/`terrainKey`/`chartEpoch` mismatch warns + falls back.
- No terrain is FATAL: `ServerAPI.loadWorld` rethrows `[terrain] world "<id>" has no terrain`; every caller stops its server first. `elevationAtLocal(frame,x,y,z)` = exactly `|p|-radius`; `ctx.terrainHeightAt` is NOT that.
- `PlanetFrame.groundHeightLocal` keys 4096 direct-mapped slots on EXACT `(x,z)` + chartEpoch.
- `terrain.glsl`'s `snoise3`/`vnoise2`/`seaHash`/`hpfSample` take the in-cell fraction as `P-floor(P)` from ONE `floor`. The server terrain collider is ONE fixed-anchor local tangent plane (`anchorDir` default [0,1,0]), so it can't represent directions past ~87 deg from anchor.
- `gl-render.js sampleGroundM` is fire-and-forget async, so each call returns the PREVIOUS call's height; non-rAF callers use `sampleGroundMSync`, which poisons the next async read.
- `VegPlacement.js`/`RockPlacement.js` read climate before `surfaceOfCell` only when `climateUsesLocalXZ !== true`. Veg density must gate on painted snow, else surviving grass weight roots trees. Slope caps differ between `VegPlacement` and `GrassPlacement` (`SLOPE_MAX` 0.6 vs 0.9).
- REFUTED: `PlacementChart.js radialSlopeAt`'s 2-tap forward difference — the gradient crosses `SLOPE_MAX`, flipping gate decisions. Skipping a three.js attribute upload is safe only because a buffer is seeded from the whole CPU array on creation.

## Netcode and wire

- Prediction suppresses only the blocked DIRECTION: `_reconcile` (`PredictionEngine.js`) derives `wedgeNormal` from commanded-vs-achieved motion, else `-velocity` when stopped while commanding; `characterStep.js` projects out that component alone.
- `msgpack.js` `WIRE_STRUCTURES[1]` is the SNAPSHOT PAYLOAD — 10 keys in `_packPayload` order (`TickHandler.js`): `seq,tick,serverTime,players,entities,removed,delta,dots,me,chartEpoch`. It is NOT the player record. msgpackr 2.0.4 writes -0 as `0x00`; raw ws clients mirror `COALESCE_SENTINEL` 0xff (`0xFF` + `[uint32 LE length][msgpack]`).
- The wire v3 player record is a DIFFERENT structure (`SnapshotEncoder.js encodePlayer`): 8 fields `[id,bin,onGround,health,crouch,pitchYawWord,expr,weapon]`, `bin` = the 22-byte `packPlayerBinRecord` pose (`SnapshotBinFormat.js`); past LOD `packReducedPlayerPose` swaps in 5 fields / 15 B. Per-recipient `me` = `encodeSelfBlock`'s `[inputSequence,inputBufferDepth,groundNormalWord,wallPlanes]`, so snapshots pack per recipient.
- `msgpack.js` resolves its Packr ASYNCHRONOUSLY: `pack`/`unpack` throw until `await ensurePacked()` resolves. Packr/Unpackr options are asymmetric (`useFloat32: NEVER` vs `DECIMAL_ROUND: 3`); never symmetrize them. The non-node branch hides the msgpackr specifier behind an IIFE; never flatten it.
- `InputCodec.js encodeInputPacket` silently keeps only the newest `MAX_INPUTS_PER_PACKET` 8 and drops the rest with no error; `quantizeInput` is lossy and clamping (pitch above HALF_PI -> 1.5707963, yaw rewrapped over 65536 steps).
- `PhysicsNetworkClient.connect()` REJECTS with a named `TransportConnectError`, never `connected:false`; retry belongs in the caller (`_doReconnect`). `err.reason` is stable: `websocket-unavailable`, `-closed-before-open`, `connect-superseded`.
- Prediction lead is capped by `MAX_PREDICTION_LEAD_STEPS` = 16, and penetration is FLOORED by it: a `kinematic` wall hands the client NO plane (`wallPlaneTicks === 0`), so it cannot know the wall exists until the server touches it. Bound prediction error in STEPS of travel, not metres.
- `SnapshotGroupPlanner`: groups = `ceil(viewers*perViewerMs/(budgetMs-fixedMs))`, budget = tick period * `SNAP_COST_HIGH_FRAC` 0.35; `getRelevanceRadius` falls back to 0 only where omitted.
- Lockstep: rollback is input-capped, so measure by depth, not rate (`maxRollbackTicks` 12); `maxRollbackTicks + inputDelayTicks >= windowSize` throws; `inputDelayTicks` above `INPUT_RETAIN_TICKS` (240) throws at construction.
- A socket becomes a player by MIGRATE, RECONNECT, or silence past the MIGRATE-peek grace (`ServerHandlers.js onClientConnect`, 50 / 1500 ms). A silent probe joins as a phantom, so probes use `?probe=1`; never answer an unresolvable RECONNECT with INVALID_SESSION and leave it open.
- Migration keeps the old transport as fallback owner. Router- and worker-minted ids are separate fields (`routerPlayerId`/`localPlayerId`): one shared field made both misses silent.
- Authoritative path: prediction off by default (`?predict` only). `processPlayerMovement` takes ONE input per tick, catching up only while `inputs.length > INPUT_BUFFER_CATCHUP_DEPTH` 8. A 0 or NaN checksum interval makes `isChecksumTick` false every tick, so `DesyncDetector` silently passes.
- Health is attested, not defaulted: `readHealth` returns a frozen `{known:false}` whose `hp` getter throws, so an omitted health must not read as full.

## Rendering

- `WebGPURenderer` is DEFAULT (`?legacygl=1` opts out); unavailable WebGPU retries `forceWebGL=true` before legacy, so TSL is the only shader path. `ClusterLodMesh._render` fires once PER GROUP per frame: keep the `_lastRenderFrame===frame` early-return.
- **A WebGPU pipeline that fails validation dispatches nothing and surfaces nothing**: three caches the wrapper before the compile result and `draw()` returns early on it, so the shape stays broken for the process lifetime; errors arrive only async via `device.onuncapturederror`. Mitigation `installStuckPipelineRecovery` (`SceneSetup.js`): repeated `/RenderPipeline|CommandBuffer/` errors force `material.needsUpdate` scene-wide.
- Default terrain FS is TSL, not `terrain.glsl`: `TerrainBackdrop.js` imports `mapspinner/src/tsl/planet-tsl.js` when `isWebGPU`. `terrain.glsl` = legacy path + height-parity SoT (`gen-height.mjs`); deleting it needs a new SoT + generator. Every discard in it stays inside `#ifdef _WATERPASS_`.
- `terrain-lighting-tsl.js` gates `sky.marchRadiance` on `apGate > 0`. The always-paid water cost is the VERTEX stage (`WATER_DRAWS_BEFORE_OTHER_TRANSPARENTS` -1 only orders inside the transparent list). `side = DoubleSide`, so backfaces are never culled (s7).
- TSL `select` outside `uniformFlow` emits a real `if/else` (`ConditionalNode`), not a ternary: both sides are NOT evaluated. VDRS has no live consumer (zero `vdrs` under `packages/mapspinner/src/tsl`).
- `invertAcesFilmic` must NOT end in `max(x, 0)`: saturated blue inverts out of AP1/ACES gamut and clamping mis-encodes it. Rendered sea = sphere R == `PlanetFrame.waterlineLocalY` to 1 cm; waves are ZERO-MEAN. `?legacygl=1` flips terrain hashVersion, so a legacy run isn't comparable to TSL.
- `ShadowPipeline.js forceUpdate(movers, eye)` dirties only the cascades whose camera-distance band, widened by `CASCADE_BLEND_M` plus `SHADOW_REDRAW_CASTER_HEIGHT_M / tan(sun elevation)`, contains a moved caster; without movers it dirties all. `cascadeCount` clamps to 1 when `sun.castShadow===false`; selection cross-fades over `CASCADE_BLEND_M` 4 m.
- **Cascade selection must live on the sun**: cascades 1..n are `DirectionalLight(0xffffff, 0)` and three folds a shadow into its own light, so a selection weighted inside cascade i multiplies into zero light; `CascadeShadowSelectTSL.js` folds `shadow(cascade0..n)` by camera-distance band into ONE `shadowNode` on the sun. The earlier `mix(1, shadow, w)` form meant **no shadow past 60 m**; inert cost 0.6 draws/frame at a high sun (s14; the far field is UNMEASURED).
- Vegetation `InstancedMesh2`: `CullFreeze.js setInstancedCullAuto` sets `autoUpdate` on parent AND every LOD level. `model-pool.js` drains must allow >=1 unit/frame or a zero budget deadlocks. Species build yields on a macrotask at `BUILD_SLICE_BUDGET_MS` 8 ms, prewarm at `PREWARM_SLICE_MS` 96 ms (`Vegetation.js`, s11).
- QualityGovernor drives only GOVERNED_KNOBS (ssao, bloom, ssr, vegLeafOff, maxLevel, splitFactor) and refuses a driven key in RESOLUTION_KEYS (`dpr*`, `vdrs*`, `threeVdrs*`, `fsr1*`, `halfResWater`, `bloomResolutionScale`): no pixel doubling. `qualityGovernor` defaults TRUE and is no longer hitch-blind: an overrun latch sheds a tier within `HITCH_RESPONSE_BOUND_FRAMES` on a 30-frame mean+p95 (100 ms in 1 frame). `splitFactor` is INERT — every tier floors `splitDist` to its 1.1 minimum, so terrain quality moves only in whole `maxLevel` steps.
- **`?knob=` is read ONLY by `perf-run.mjs`** (CDP `addScriptToEvaluateOnNewDocument`): `grass-prewarm-boot-witness.mjs` has no such flag, so `knob=qualityGovernorOff=true` on it is a silent no-op. Assert `window.qualityGovernorState` instead of citing the flag.

## Client and app runtime

- HUD `applyDiff(container, hudVdom)` (`AppModuleSystem.js` renderAppUI) is 4 Hz, not per frame, and already diffs in place: 0 writes for an unchanged subtree, 1 text write for a one-field change.
- webjsx (`node_modules/webjsx`) has no `newVNode instanceof Node` branch, so a real DOM node in a vdom throws inside `createDOMElement` and `renderAppUI`'s try/catch silently freezes the HUD; `anentrypoint-design` re-exports vendored `vendor/design/vendor/webjsx`, which has that branch.
- `_buildWorldScenery` is joinable: boot adopts a running build. `app.js animate()` returns early while `window.__warmupInFlight`; never park a wait inside warmup.
- Client `WORLD_DEF` from `sendWorldDefAndModules` has `entities` STRIPPED and carries `_modelUrls`: derive world-entity facts from `_modelUrls`.
- Hot reload releases ctx via `AppRuntime._releaseAppContext`; `update()` keeps running with a torn-down ctx unless `_updateList`/`_rebuildCollisionList` are rebuilt. `AppRuntime._attachApp` does `apps.set` BEFORE awaiting `setup()`.
- `src/apps/CustomVersion.js`: `Reflect.set` is a deliberate raw write; a read must not reach the set trap and bump `_customV`.
- Spawn: `holdSpawnUntilGrounded` gates release on `terrainFieldMissingAt`/`coversPosition` (max `SPAWN_HOLD_MAX_MS=20000`); `staticCollidersPendingNear` is true whenever `AppRuntime._pendingTrimeshBuilds.size > 0`.
- Respawn clearance is shared: `AppGameplay.js pickSpawnPoint` + tps-game use one `footprintBlockers` sampler (17 columns; surface > `MAX_FOOTPRINT_INTRUSION_M` 0.15 m above a column bottom = `intruding`).
- `BrowserServer.js`: `_lastTodSync` + `_deliveredWorldFingerprints` are MODULE level, so stall recovery + HostMigration rebuild a fresh BrowserServer in the same page. `FloatingOrigin.js update()` does `camera.position.set(0,0,0)` on rebase.
- rAF is throttled or stopped in a HIDDEN tab; `MessageChannel` `postMessage` is the yield primitive (no 4 ms clamp, no hidden-tab throttling).
- **client/hud IS node-witnessable**. A `node:module` `registerHooks` resolve hook redirects bare `anentrypoint-design`, the dynamic `wireweave`/`xstate` imports and root-relative `/src/...`.

## Measurement and witnessing

- Measured figures, refutations and instrument/adapter notes: `docs/measurement-figures.md`.
- Per-pass GPU timings (`p50Ms`,`p95Ms`,`avgMs`) are INVALID as GPU-bound measures (lane a368d997, s0); a 0 duration is UNWRITTEN (65.5 us granularity). AMD iGPU `--gpu-passes --extra=gputime=1 --backend=webgpu` is INVALID too.
- rAF-to-rAF frame wall is vsync-quantized: every median is a multiple of the 16.68 ms refresh period, so a `maxLevel` ladder resolves only as a 60/30 fps ordinal. Main-thread CPU (ThreadTime) is NOT quantized and resolves level cost; no `perf-run.mjs` instrument unlocks vsync (only `frame-time-gate.mjs` behind `UNLOCK_RAF`).
- **A spot-sampled maximum under-reports**: a max sampled once per server tick only lower-bounds it — measure per predicted step. `prediction-wedge-witness.mjs` sanctions a clear-lane lead 0.41452..1.22937 m against exhaustive penetration 0.0825..0.39667 m, so `PEN_STEP_TOL_STEPS` 16 (`PEN_STEP_TOL_M` = 16 x `STEP_TRAVEL_M`, `PEN_LEAD_FRAC` 1.0) prices the bound — the retired absolute 0.6 m was 2.94 steps; `--probe=wallpush --probeOvershootM=1` reads 2.4 m.
- **A nearest-surface probe caps its own reading at HALF the probe thickness**: past the mid-plane the far face becomes the nearest one and the number turns back down (`PEN_M` / `WALL_HALF_THICK_M` 3, `prediction-wedge-witness.mjs`).
- **Quality and fidelity are two different claims**: a knob that sheds a tier works as designed even when the picture is unacceptable; verify any GOVERNED_KNOB or LOD/impostor threshold change **visually, per tier and across near/mid/mesh-far bands** (near-range leaf/branch loss is invisible to frame time) and never buy frame time by widening a distance band.
- Pin each GPU arm's adapter: `vendorGpuArgs(vendor)` adds `--use-adapter-luid=0,<luid>` (`gpuLaunchArgs()` doesn't); Chrome ignores an unresolvable LUID while reporting accelerated, so assert `window.__rendererInfo`. `gpulock` serializes the adapter, never the CPU.
- Decide perf rows on counted work units: a never-incremented counter is a silent pass (`vegProfile.meshInstances` is absent on `WebGPULodInstancer`). Authoritative draw count = `drawsInstrument.authoritativeField` (`wgpuDrawsPerFrame`/`glDrawCallsPerFrame`).
- Toggles: `?lightplanet` stubs the planet but keeps the height sampler + foliage; `?veg=none`, `?nograss`, `?norocks` are real. `perf-run.mjs`: `?gpuhide=`/`?gpuab=<name>`, `?gpuabms=<ms>`, `--knob=<key>=<value>`; keys are registry `key`s verbatim (`maxLevel`, not `__maxLevel`). Limits: `maxLevel` 2..22, `splitFactor` >= 0.05.
- `dprAuto` defaults `false` (`RenderControls.js`); measuring arms pass `--knob=dprOff=true`. `halfResWater` reads as `=== true` (`gl-render.js`), so unset = OFF.
- WebGPU parity: a region matches iff cross-renderer meanAbs/channel <= `K` x the same-renderer noise floor (`scripts/tsl-parity/analyze.mjs`); establish the same-code floor first (s8).
- CDP (`cdp-browser.mjs`): an init script `(() => { ... })` is a discarded EXPRESSION — end it in `())`; `page.evaluate(string)` takes an EXPRESSION. Assert `installed === true`, else an absent counter reads as a measured zero.
- A hook that never fires in the main pass is a broken instrument: assert `mainRenders > 0`. Classify a shadow draw by `light.shadow.camera === camera` with `onBeforeRender` patched on the prototype that OWNS it.
- A witness with a fixed scratch dir must `rm` it at start. `edge-collider-draco-witness.mjs` rewrites tracked `apps/tps-game/*.glb` in place: never run it in a gate.

## Security

- Re-run the dependency scan on any fresh or updated `node_modules`.
- `SESCompartmentEvaluator.js` is the only untrusted-app evaluator and fails closed (`SandboxUnavailableError`); `StaticHandler` enforces path containment + COEP `require-corp`. A failed `import('ses')`/lockdown throws: ses is only in optionalDependencies.
- `authCompare.js timingSafeTokenEqual` self-compares (`bufA,bufA`) on a length mismatch so token length isn't leaked: don't simplify it away.
- Benign exec surfaces, never flag as malware: `lang/spoint.js`, `mapspinner/planet.html`, `scaffold.js`, `cdp-browser.mjs`.
- Witness CLIs taking `--module=<path>` load that path as code: point them only at trusted files.
