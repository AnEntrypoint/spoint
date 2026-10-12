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

`sN` = section N of `docs/measurement-figures.md` (s0..s13). Cite `path` + symbol, not line numbers: `scripts/agents-md-facts-witness.mjs` re-checks every path AND line claim here against the tracked tree.

## Working rules

- Commit lanmower, main-only, one author, no trailers. `git_commit {message, paths}` (pathless `git_finalize` sweeps another lane). Push the LITERAL sha.
- Git verbs starve on a PHANTOM hold: state-changing ones return `dispatch_starved_waiting_for_serial_lane` at a fixed 240 s budget; read-only ones pass. Bypass: `scripts/lib/git-api-publish.mjs` (blobs base64 CRLF->LF, tree on remote tip, PATCH ref). Text paths read UTF-8 CRLF->LF, `--binary` byte-exact.
- `ci-status` ignores `rev`: an unpushed sha answers `unknown` + 422 — query `gh api .../commits/<sha>/check-runs`. No `jq`: use `node --input-type=module -e`.
- A red `npm run check` is usually FOREIGN (stale bake pins; the `apps/world/tps-game.hf` height code moves with terrain): read the failing line first. Re-bake with `scripts/bake-heightfield.mjs --extent 256 --res 1 --sector 16 --bits 16`.
- `check-cache-keys.mjs` is shared: editing another transform's `BAKE_INPUTS_*` reddens `check` for every lane until the pin bumps in the SAME commit. `check.mjs` parses TRACKED files only; compute pins in a worktree at `origin/main`.
- CRLF: `core.autocrlf=true` only in SYSTEM config; 203 files are index-LF + worktree-CRLF, so `w/crlf` in `git ls-files --eol` = no diff.
- `.gitignore` re-includes `.gm/*` only for `.gm/memories/`, `.gm/disciplines/project/`, `.gm/witness-log.md`, `.gm/witness-out/`, `.gm/pool/pool.log`.
- Untracking: `git_rm {cached:true}` + paths-scoped `git_commit {index_commit:true}`. `.git/index.lock` fails `git_commit`; a foreign stalled git holds it 20+ min.
- Generated artifacts ship with source: `AppContext.js` -> `client/editor/sdk-typings.generated.d.ts`, from the AppContext import closure read through the GIT INDEX (a pre-commit hook refuses a commit changing that closure without it).
- gm MCP is HTTP on `127.0.0.1:8787/mcp` and never retries, so a startup gap detaches it (`/mcp` recovers). Spool body = `in/<verb>/<session>-<pid>-<epochms>-<rand>.txt` + `.inflight`; write `.tmp` then RENAME.
- Subagent ceiling is 20, shared with peers: a spawn refusal does NOT mean this walk over-subscribed.
- `@spoint/ecs` resolves only via `@spoint/*`; the link can vanish mid-session (`npm run links`; never `npm install`).
- `scripts/gpulock.mjs run <owner> [--wait-ms N] [--ttl-ms N] -- <cmd>` serializes accelerated arms (2 s heartbeat, 120 s TTL) and propagates the child's exit code.
- Never `git worktree remove` a `scripts/worktree-setup.mjs` worktree (its node_modules junction deletes `node_modules/.bin`); use `scripts/worktree-teardown.mjs`.
- CI: completing jobs = `check` + `frame-time-coverage`; `frame-time` needs `vars.CI_GPU_RUNNER_ONLINE == 'true'` (else SKIPPED). `concurrency` is PER SHA. CI Node 20; box Node 24. Judge the newest CI-evaluated commit: `check-runs` on a `[skip ci]` bump is zero and reads as pass.
- `npm run check` parses only tracked `src,client,apps,scripts,bin`; a witness must exit 0 AND print `RESULT: PASS`. One NOT listed in the gpu-free arm of `scripts/check.mjs` never runs.

## PRD rows and witness binding

- A PRD row id is a claim until `prd_list {"id":...}` resolves it. Never re-type a row id, body, dispatch id, witness id or sha. `prd_list {"filter":...}` is not a selector. Row ids collide across sibling sessions, so a `prd-add` can overwrite another lane's row.
- `prd_resolve` needs a `witness_dispatch_id` in THIS project's `.gm/exec-spool/.dispatch-ledger.json`, or all four of `witness_exit_code`, `witness_output_sha256`, `witness_output_path` (RELATIVE to the root), `witness_ts`; `witness_evidence` is mandatory.
- `.gm/prd.yml` has a concurrent-lane lost update: an `ok:true` `prd-add` can later answer "prd id not found". Fix = re-add the id, then resolve. `git_finalize` on it is refused (`prd_foreign_rows`) while other sessions own rows.
- `prd.rs` reports `not_rerunnable` when a row's witness cites no existing `scripts/*.mjs|.js|.cjs` — a REPORT, not a regression; an inline-`exec_js` row stays completed but can never be re-verified.
- A truncated witness is a fabricated witness: never `.slice()` a log line you quote a number, flag or path from.

## Repo boundaries

- `design` ships as pinned CDN URLs in `client/{index,landing/index,editor/thebird-host}.html` + `scripts/bundle-client.mjs`; `vendor/*` = editing-only submodules.
- `apps/*` never imports `client/*` (singleplayer Worker resolves relative specifiers vs a virtual root); expose utilities on `engineCtx`. `apps/world/index.js` is the default-world authority.
- Node-only dynamic import specifiers stay opaque to esbuild/wrangler: IIFE, e.g. `src/sdk/EditorHandlers.js`. `edge/cf-do/spoint-do.js` imports `jolt-edge-init.js` BEFORE `WorkerEntry.js`.

## Debugging discipline

- A bug surviving a threshold change isn't fixed. A cause in a report is a claim until instrumented; fix at its own layer end-to-end — a second copy of the same check isn't a fix (`ShapeBuilder.js`).
- **Silent-no-op class**: a knob with no consumer, or whose enable bit defaults off, measures nothing — codesearch the reader + enable bit first. Cases: `?noveg`, `__vdrsScale` (needs `window.__vdrs===true`), `?legacygl=1`, `u.fsCheap`, `perf-run.mjs inputReachedGame`, MICRO_JITTER. REFUTED: `--no-walk` — it has a real reader, `const WALK = !has('no-walk')` in `scripts/perf-run.mjs`; it empties the movement legs, so a `--no-walk` arm is measuring an idle walk, not a broken knob.
- **Silent-default class**: `Number.isFinite(x) && x > 0 ? x : literal` and `v ?? DEFAULT` both turn invalid input into the default. Parse the whole record at ONE boundary and refuse there (`src/terrain/ColliderStreamer.js`, `src/stage/stageShapes.js`). `typeof v === 'number'` admits `1e999`.
- **No sentinel for absence**: "no ground" is a rejected variant (thrown `NoGroundHeightError`), never 0 or NaN. A retain-previous closure seeded with 0 collapses a live height and the seed into one number; `null` compares as 0 so land paints at sea level. `guardedGroundHeight(where, heightFn)` takes TWO args.
- **Refusals carry a code, not prose**: `createClusterAssigner`, `assertWorld`, `StageLoader` (`StageConfigError.reasonCode`), `TickHandlerAOI` (`position|noPosition|unknownEntity`).
- **A module-level "report once" latch leaks across in-page rebuilds**: `PlanetFrame.guardedGroundHeight` deduped on a module-level Set, so a rebuilt `BrowserServer` never reported missing ground again. Put the latch on the returned closure.
- **A witness that mints ids as strings never reaches the parse boundary and pins nothing** — mint integers. A fixture that never stamps a sender fails every `handle()`, since `senderOf` reads the symbol `stampSender` writes.
- **A bare CLI flag parses to the string `'true'`**, so `Number()` yields NaN and disables the knob it sets. libuv `uv_async_send` asserts at `process.exit()` with handles mid-close.
- A witness needing the server to act on a client message passes `--params=multiplayer` (`?singleplayer` sees `players:0`). A harness returning uncompared `{expected, got}` passes either way: one `expect()` per measurement.
- One `gl.getError()` code covers distinct bugs (1282 = feedback-loop, sampler-type-mismatch AND insufficient-buffer-size): read the driver's console string. Live GL: `window`/`document` only via `page.evaluate()`; pin file:line via `addInitScript`.
- `witness-audit.mjs --gate` = gpu-free arm of `npm run check`, HIGH tier only, vs committed `.witness-audit-baseline.json`; fails on an absent check id or a higher count. The LOW tier (`empty-catch`, `swallowed-error`) is advisory. `--gate` audits committed tracked scripts; bare runs walk the worktree.

## Entry points

- `ctx.defineGameFSM(spec)` `src/behaviours/game-fsm.js`; `ClientMachine.js` xstate5 parallel, fallback `after:` 10 s gated / 45 s hard stop. `ctx.defineFire(spec)` `src/behaviours/fire.js` (wired in `src/apps/AppContext.js`, default off).
- Test relocation: `window.__spoint` + `MSG.TELEPORT` (0xc2 / ACK 0xc3, `src/sdk/Relocation.js`; no `EDITOR_TOKEN` = any client; >87 deg refuses).
- Client `ctx.state` = entity `custom` block (`AppModuleSystem.js`), not server app state: `ctx.state.<key> ?? literal` takes the literal forever. `engine.cam` = camera CONTROLLER, no `position`; read `engine.client.getLocalState().position`.
- Wireweave attach helpers run after awaits (host migration reassigns `client` in `app.js`): re-check at call time. `createServer()` is a per-call factory; `boot()`'s signals are process-global: stop with `RoomDirectory.stopAll`.
- A remote server's `netcode.profile` is named only when the client is a real `PhysicsNetworkClient`: boot that witness on `?connect=...&multiplayer=1`, else in-page `BrowserServer`.

## Fire

- Integer-only kernel `fireKernel.js`: decisions from `hash(seed,step,face,I,J)`; no float, `Math.random` or `Date.now`. Per-cell step = `burnCell`.
- Rain smothers, doesn't eat fuel: a suppressed cell still burns `burnRate`, pushes no heat, spots nothing. Intensity 0..1 -> roll byte (255) via `rainPerIntensity` (`fireSpec.js`).
- `ctx.navCostAt(x,z)` = 8 burning / 2 charred (`_fireNavByRuntime`); `canSee` is smoke-gated at depth >= `smokeBlockDepth`. Wind = weather BASE + `hash(seed,step)` gust, clamped +-16/axis; `snapshot().wind` carries BASE only.
- Per-cell initial fuel isn't recomputable in the kernel: a per-tile array in `snapshot()`/`restore()` joins `TILE_ARRAYS` + VERSION bump.
- A tampered keyframe is rejected at DECODE. `G` = ignition step mod 256, not age; IGNITE_AREA kind 5. `fireKeyframe.js` raises `[fireKeyframe]`; `rewindTo` restores one. A boundary `delta` rolls back the step BEFORE it; restore verifies against `counters`, never `delta`.
- A fire record promising work with no sampler is refused at construction (`src/behaviours/fireTerrain.js`): `firebreaks.kinds` defaults to `['road','river']` while `kindAt` is null; `firebreaks.water` defaults true while `heightAt`/`seaLevelAt` are null.

## Planet-wide multiplayer

- One server world per cluster, own flat chart. Jolt heap fixed at 134217728 B (`JOLT_WASM_HEAP_BYTES`, `src/shared/clusterConfig.js`), never grows; over it `new J.JoltInterface` raises `Aborted(OOM)`.
- `maxContactConstraints` under requirement drops contacts silently; `maxBodies` under population makes Jolt return body id 0, so overflow bodies share a map key and `destroy()` aborts wasm. Assignment is pure, hysteretic, 2-4 Hz.
- Collider rings: `DEFAULT_MAX_CENTERS = 192` for BOTH trunk + rock streamers; rings per connected player, never centroid; `evictOverCap` is farthest-first; graded by `classifyRings` (`src/terrain/ColliderStreamer.js`).
- Clusters are OFF in every shipped world (`apps/world/tps-game.js`, `apps/world/tutorial.js` declare `clusters: { enabled: false }`). The world-def parser makes the mismatch unrepresentable both ways (`world-clusters-enabled-without-planet-radius`, `world-planet-radius-unreachable`); `terrain: true` is refused because `worldDefParse` and `resolveTerrainConfig` read it oppositely.
- Flat AOI is HORIZONTAL (`getRelevantEntitiesHorizontal`, chosen when `planetRadius <= 0`): zero vertical slack. `nearbyHorizontal` no longer occurs in `src/spatial/Octree.js`.
- `StageLoader.js` throws when a radius is declared without enabled clusters and resolves config on EVERY load: six `ClusterConfigError` codes can throw at boot and on hot reload.

## Chart re-anchor

- Chart-local server holders migrate via `src/sdk/chartState/` (`attachServerChartMigrators(ctx, service)`). Re-anchor = change of basis, not rotation: position/velocity/forward invariant. CHART_REANCHOR = 0xc6.
- Flat chart tilt is fixed by shrinking the chart: `CHART_ANCHORS_PER_FACE = 32`. `CHART_REANCHOR_ANGLE_DEG` (28 / 14) must exceed `createChartAnchorLattice`'s worst angle or the anchor thrashes; hysteresis 0.75. Exactly ONE chart per world; players at separation Delta sit at Delta/2, walkable iff `terrainTilt + Delta/2 <= 45 deg`.
- `chartEpoch` keys re-anchor: `ChartReanchorService.js`, `ChartReanchorTerrain.js`, `FieldLattice.js`, `ColliderStreamer.js`, and the `groundHeightLocal` memo gate on it.

## Physics and Jolt

- `physics.setBodyMotionType` returns a NEW body id or `false`. A Static-created body can't simulate via `SetMotionType`, hence recreation. `IsActive()` is the only discriminator: `GetMotionProperties()` is non-null even on a static-created body.
- Recreation creates the new body BEFORE destroying the old, on `LAYER_DYNAMIC`; refuses a body holding a constraint, vehicle chassis or trimesh/mesh/heightfield shape.
- A pooled body whose `bodyMeta.type` != requested motionType is destroyed + replaced (pool key = model|scale only). `getBodyPosition` returns the shared temp: copy before the next call. Jolt recycles removed bodies' tree nodes only in `physics.step`.
- Jolt `HeightFieldShape` exposes `GetMinHeightValue()`/`GetMaxHeightValue()`/`GetSampleCount()`, NOT `get_mMinHeightValue`; `GetSampleCount()` = PER-SIDE count (N), not N*N.
- Trimesh/convex collider build failure in `src/apps/AppPhysics.js` PROPAGATES as `ColliderBuildError`; never degrades to a 0.5 m box. `AppRuntime`'s `config.autoTrimesh` branch + `EditorHandlers.js` still box. `changeBodyType` clears `ent._bodyDef` for static.
- `AppRuntimePhysics.js` skips `e._vehicleId != null` in BOTH `_tickPhysicsLOD` and `_enforceBodyBudget`; the sweep runs only every `_physicsLODInterval` ticks. `Math.round` of a negative height sample yields -0, which differs from +0 as `Float32Array` bits.
- `VehiclePhysics.js`: never `J.destroy` `v.constraint`/`v.tester` after `RemoveConstraint`, nor `get_mTracks()` copies after `set_mTracks`; empty `mDifferentials` = zero wheel torque.
- EDITOR_UPDATE calls `syncEntityCollider` AFTER `changeBodyType` (which removes the body and clobbers `custom._collider`). A force no body ever received must not become entity velocity — `runtime.applyImpulseToEntity` answers `false` for exactly that.
- Physics frame cost is `physics.step` (~0.331 ms/frame); LOD sweep + budget are under 7%; noise is +-0.06 ms per call.

## Terrain and colliders

- `solveSurfaceY` tolerance absolute `1e-4` (`SURFACE_SOLVE_TOLERANCE_M`, `PlanetFrame.js`), 64-eval cap, throws `SurfaceSolveError`; past 63.6 km it returns `-(R+anchorHeight)` with no throw.
- Baked heightfield FAIL-LOUD (`src/terrain/TerrainPhysics.js`): absent = silent CPU fallback; unreadable/truncated/bad-magic/stale-code throw `[baked-heightfield]`; `hashVersion`/`terrainKey`/`chartEpoch` mismatch warns + falls back. Carves are v2-only (s9).
- No terrain is FATAL: `ServerAPI.loadWorld` rethrows `[terrain] world "<id>" has no terrain`; every caller stops its server first. `elevationAtLocal(frame,x,y,z)` = exactly `|p|-radius`; `ctx.terrainHeightAt` is NOT that.
- `PlanetFrame.groundHeightLocal` caches in 4096 direct-mapped slots keyed by EXACT `(x,z)` + chartEpoch. Walking hands it a fresh coordinate nearly every time, so hit rate is ~0.3% and a bigger cache buys under 0.07 ms/frame.
- `terrain.glsl`'s `snoise3`/`vnoise2`/`seaHash`/`hpfSample` take the in-cell fraction as `P-floor(P)` from ONE `floor`. Server terrain collider = ONE fixed-anchor local tangent plane (`anchorDir` default [0,1,0]): can't represent directions past ~87 deg from anchor.
- `gl-render.js sampleGroundM` is fire-and-forget async (PBO+fence), so each call returns the PREVIOUS call's height; non-rAF callers use `sampleGroundMSync`, which poisons the next async read.
- `VegPlacement.js`/`RockPlacement.js` read climate before `surfaceOfCell` only when `climateUsesLocalXZ !== true`. Veg density must gate on painted snow, else surviving grass weight roots trees. Slope caps differ: `VegPlacement SLOPE_MAX` 0.6, `GrassPlacement SLOPE_MAX` 0.9.
- REFUTED: `PlacementChart.js radialSlopeAt`'s 2-tap forward difference — the gradient crosses `SLOPE_MAX`, flipping gate decisions. Skipping a three.js attribute upload is safe only because a buffer is seeded from the whole CPU array on creation.

## Netcode and wire

- Prediction suppresses only the blocked DIRECTION: `_reconcile` (`PredictionEngine.js`) derives `wedgeNormal` from commanded-vs-achieved motion, else `-velocity` when stopped while commanding; `shared/characterStep.js` projects out that component alone.
- `msgpack.js` `WIRE_STRUCTURES[1]` lists exactly the keys, in order, of `TickHandler.js _packPayload`. msgpackr 2.0.4 writes -0 as `0x00`; `patch-deps.mjs` excludes -0 from both integer tests. Raw ws clients mirror `COALESCE_SENTINEL` 0xff: `0xFF` then `[uint32 LE length][msgpack]`.
- Wire v3 player record: 8 fields in a 22-byte bin; `[inputSequence, inputBuffer, groundNormal]` ride a per-recipient `me` block, so snapshots pack per recipient. `getSnapshot()` keys on `_version === _snapshotVersion` alone.
- `PhysicsNetworkClient.connect()` REJECTS with a named `TransportConnectError`, never `connected:false`; retry belongs in the caller (`_doReconnect`). `err.reason` is stable: `websocket-unavailable`, `-closed-before-open`, `connect-superseded`.
- Prediction lead is capped by `MAX_PREDICTION_LEAD_STEPS` = 16. Bound prediction error in STEPS of travel, not metres — metre bounds are box-load sensitive.
- `SnapshotGroupPlanner`: groups = `ceil(viewers*perViewerMs/(budgetMs-fixedMs))`; budget = tick period * `SNAP_COST_HIGH_FRAC` 0.35. `relevanceRadius` is set by worlds (`src/presets/tps.js` 200, `apps/world/construct.js` 100); `getRelevanceRadius` falls back to 0 only where omitted.
- Lockstep: rollback is input-capped, so measure by depth, not rate (`maxRollbackTicks` 12); `maxRollbackTicks + inputDelayTicks >= windowSize` throws; `inputDelayTicks` above `INPUT_RETAIN_TICKS` (240) throws at construction.
- A socket becomes a player by MIGRATE, RECONNECT, or silence past the MIGRATE-peek grace (`ServerHandlers.js onClientConnect`, 50 / 1500 ms). A silent probe joins as a phantom, so probes use `?probe=1`; never answer an unresolvable RECONNECT with INVALID_SESSION and leave it open.
- Migration keeps the old transport as fallback owner. Router- and worker-minted ids are separate fields (`routerPlayerId` / `localPlayerId`): one shared field made both misses silent.
- Authoritative path: prediction off by default (`?predict` only); rollback/lockstep unwired. `processPlayerMovement` takes ONE input per tick, catching up only while `inputs.length > INPUT_BUFFER_CATCHUP_DEPTH` 8. A 0 or NaN checksum interval makes `isChecksumTick` false every tick, so `DesyncDetector` silently passes.
- Health is attested, not defaulted: an omitted health read as exactly full health because every reader substituted the default at the point of read (`readHealth` returns a frozen `{known:false}` whose `hp` getter throws).

## Rendering

- `WebGPURenderer` is DEFAULT (`?legacygl=1` opts out); unavailable WebGPU retries `forceWebGL=true` before legacy, so TSL is the only shader path. `ClusterLodMesh._render` fires once PER GROUP per frame: keep the `_lastRenderFrame===frame` early-return. HiZ cull must equal the CPU cull.
- Veg LOD: `WebGPULodInstancer`'s oracle mirrors `updateLOD`; `lodEye` refreshes only after 0.5 m (`LOD_REEVAL_MOVE_SQ`). A leaf instancer is a SATELLITE of its branch (`opts.host`).
- Default terrain FS is TSL, not `terrain.glsl`: `TerrainBackdrop.js` imports `mapspinner/src/tsl/planet-tsl.js` when `isWebGPU`. `terrain.glsl` = legacy path + height-parity SoT (`gen-height.mjs` transpiles it); deleting it needs a new SoT + generator. Every discard in it stays inside `#ifdef _WATERPASS_`.
- `terrain-lighting-tsl.js` gates `sky.marchRadiance` on `apGate > 0`; Terrain `renderOrder` 10. `WATER_DRAWS_BEFORE_OTHER_TRANSPARENTS` -1 only orders water inside the transparent list — opaque terrain writes depth first regardless, so the always-paid water cost is the VERTEX stage. `side = DoubleSide`, so backfaces are never culled (s7).
- TSL `select` outside `uniformFlow` emits a real `if/else` (`ConditionalNode`), not a ternary: both sides are NOT evaluated. VDRS has no live consumer (zero `vdrs` under `packages/mapspinner/src/tsl`).
- `invertAcesFilmic` must NOT end in `max(x, 0)`: saturated blue inverts out of AP1/ACES gamut and clamping mis-encodes it. Rendered sea = sphere R == `PlanetFrame.waterlineLocalY` to 1 cm; waves ZERO-MEAN. `?legacygl=1` flips terrain hashVersion, so a legacy run isn't comparable to TSL.
- `ShadowPipeline.js forceUpdate` sets EVERY cascade's `light.shadow.needsUpdate`; `cascadeCount` clamps to 1 when `sun.castShadow===false` (cascade 0 IS the sun, never renders).
- Vegetation `InstancedMesh2`: `sortObjects` stays false with LODs; `CullFreeze.js setInstancedCullAuto` sets `autoUpdate` on parent AND every LOD level. `model-pool.js` drains must allow >=1 unit/frame or a zero budget deadlocks. Prewarm yields on a macrotask every 24 ms (s11).
- QualityGovernor drives only GOVERNED_KNOBS (ssao, bloom, ssr, vegLeafOff, maxLevel, splitFactor) and throws if a driven key is in RESOLUTION_KEYS (`dpr*`, `vdrs*`, `threeVdrs*`, `fsr1*`, `halfResWater`, `bloomResolutionScale`): no pixel doubling. `qualityGovernor` defaults TRUE. No longer hitch-blind: an overrun latch sheds a tier within `HITCH_RESPONSE_BOUND_FRAMES` on a 30-frame mean+p95 (`scripts/check.mjs` pins 100 ms answered in 1 frame, smallest visible 34 ms).

## Client and app runtime

- HUD `applyDiff(container, hudVdom)` (`AppModuleSystem.js` renderAppUI) is 4 Hz, not per frame, and already diffs in place: an unchanged subtree costs 0 writes and a one-field change costs 1 text write. Pinned by `scripts/hud-applydiff-witness.mjs`.
- webjsx 0.0.73 (`node_modules/webjsx`, used by `client/AppModuleSystem.js`) has no `newVNode instanceof Node` branch, so a real DOM node in a vdom throws inside `createDOMElement` and `renderAppUI`'s try/catch silently freezes the HUD. `anentrypoint-design` (used by `client/hud/*`) re-exports the vendored `vendor/design/vendor/webjsx`, which has that branch.
- `_buildWorldScenery` is joinable: boot adopts a running build. `app.js animate()` returns early while `window.__warmupInFlight`; model-pool + streaming loads pump from frame jobs there, so never park a wait inside warmup.
- Client `WORLD_DEF` from `sendWorldDefAndModules` has `entities` STRIPPED and carries `_modelUrls`: derive world-entity facts from `_modelUrls`.
- Hot reload releases ctx via `AppRuntime._releaseAppContext`; `update()` keeps running with a torn-down ctx unless `_updateList`/`_rebuildCollisionList` are rebuilt. `AppRuntime._attachApp` does `apps.set` BEFORE awaiting `setup()`.
- `src/apps/CustomVersion.js`: `Reflect.set` is a deliberate raw write; a read must not reach the set trap and bump `_customV`.
- Spawn: `holdSpawnUntilGrounded` (`src/sdk/Relocation.js`) gates release on `terrainFieldMissingAt`/`coversPosition` (max `SPAWN_HOLD_MAX_MS=20000`); `staticCollidersPendingNear` is true whenever `AppRuntime._pendingTrimeshBuilds.size > 0`.
- Respawn clearance is shared: `AppGameplay.js pickSpawnPoint` + tps-game use one `footprintBlockers` sampler (17 columns; surface > `MAX_FOOTPRINT_INTRUSION_M` 0.15 m above a column bottom = `intruding`). `apps/tps-game/respawn-clearance.js` exports no `spawnClearanceMarginM`.
- `BrowserServer.js`: `_lastTodSync` + `_deliveredWorldFingerprints` are MODULE level, so stall recovery + HostMigration rebuild a fresh BrowserServer in the same page. Singleplayer worker identity comes from `INIT.worldName`; the snapshot is one IDB key `world-snapshot` per origin. `FloatingOrigin.js update()` does `camera.position.set(0,0,0)` on rebase, not `+= -delta`.
- rAF is throttled or stopped in a HIDDEN tab. `MessageChannel` `postMessage` is the yield primitive: no 4 ms clamp, no hidden-tab throttling.

## Measurement and witnessing

- Measured figures, refutations and instrument/adapter notes: `docs/measurement-figures.md` (struck values are replaced there).
- Per-pass GPU timings (`p50Ms`,`p95Ms`,`avgMs`) are INVALID as GPU-bound measures (lane a368d997, s0); a 0 duration is UNWRITTEN (65.5 us granularity). AMD iGPU `--gpu-passes --extra=gputime=1 --backend=webgpu` works only after `npm run build:client` and is INVALID too. Never split stages with a `?gpuhide=` differential.
- rAF-to-rAF frame wall is vsync-quantized: every median is a multiple of the 16.68 ms refresh period, so a `maxLevel` ladder resolves only as a 60/30 fps ordinal. Main-thread CPU (ThreadTime) is NOT quantized and is the instrument that resolves level cost.
- No `perf-run.mjs` instrument unlocks vsync (flags live only in `frame-time-gate.mjs` behind `UNLOCK_RAF`). Baselines are per-vendor; an unbaselined vendor fails loudly.
- Pin each GPU arm's adapter: `vendorGpuArgs(vendor)` adds `--use-adapter-luid=0,<luid>` (`gpuLaunchArgs()` doesn't). Chrome ignores an unresolvable LUID while reporting accelerated, so assert `window.__rendererInfo`. `gpulock` serializes the adapter, never the CPU.
- The accelerated browser lease is keyed on the PROJECT ROOT alone — keyed on the launch-args fingerprint it serializes only byte-identical launches.
- Decide perf rows on counted work units: a never-incremented counter is a silent pass (`vegProfile.meshInstances` is absent on `WebGPULodInstancer`). Authoritative draw count = `drawsInstrument.authoritativeField` (`wgpuDrawsPerFrame` / `glDrawCallsPerFrame`); WebGPU `info.render.calls` is cumulative.
- Toggles: `?lightplanet` stubs the planet but keeps the height sampler + foliage; `?veg=none`, `?nograss`, `?norocks` are real. `window.__vegAllOff` (`client/core/Vegetation.js`) kills foliage per frame; no per-part app toggle.
- `perf-run.mjs`: `?gpuhide=`/`?gpuab=<name>`, `?gpuabms=<ms>`, `--knob=<key>=<value>[,...]`. Keys are registry `key`s verbatim (`maxLevel`, not `__maxLevel`); one bad key fails the run. Limits: `maxLevel` 2..22, `splitFactor` >= 0.05.
- `dprAuto` defaults `false` (`client/core/RenderControls.js`); measuring arms pass `--knob=dprOff=true`. `halfResWater` reads as `=== true` (`gl-render.js`), so unset = OFF. An untagged template literal turns a lone `\d` into `d`: write `\\d+`.
- WebGPU parity: a region matches iff cross-renderer meanAbs/channel <= `K` x the same-renderer noise floor (`scripts/tsl-parity/analyze.mjs`); establish the same-code floor first (s8).
- CDP `Input.dispatchKeyEvent` reaches the app input bucket (`window.__app.sentInput`); keyboard sets `input.backward`, never `input.back`. `[physics] peak active 0` doesn't mean a stalled player (`CharacterVirtual` isn't counted by `GetNumActiveBodies()`).
- A witness with a fixed scratch dir must `rm` it at start (a gate killed at its 120 s cap leaves it; later runs hang). `edge-collider-draco-witness.mjs` rewrites tracked `apps/tps-game/*.glb` in place: never run it in a gate.
- **client/hud IS node-witnessable** — the withdrawn claim was that no node witness is possible. A `node:module` `registerHooks` resolve hook redirects bare `anentrypoint-design`, the dynamic `wireweave`/`xstate` imports and root-relative `/src/...`; add a document + AudioContext stub and set `globalThis.navigator` via `Object.defineProperty`.

## Security

- Re-run the dependency scan on any fresh or updated `node_modules`.
- `SESCompartmentEvaluator.js` is the only untrusted-app evaluator and fails closed (`SandboxUnavailableError`); `StaticHandler` enforces path containment + COEP `require-corp`. A failed `import('ses')`/lockdown throws: ses is only in optionalDependencies.
- `authCompare.js timingSafeTokenEqual` self-compares (`bufA,bufA`) on a length mismatch so token length isn't leaked: don't simplify it away.
- Benign exec surfaces, never flag as malware: `lang/spoint.js`, `mapspinner/planet.html`, `scaffold.js`, `cdp-browser.mjs`.
- Witness CLIs taking `--module=<path>` load that path as code: point them only at trusted files.
