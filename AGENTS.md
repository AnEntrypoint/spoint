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

- Commit lanmower, main-only, one author, no trailers; `git_commit {message, paths}` (pathless `git_finalize` sweeps another lane); push the LITERAL sha.
- A path-scoped publish is NOT content-scoped: content comes from the shared work tree and sweeps neighbours' uncommitted edits — name paths AND verify the blob.
- Git verbs starve on a PHANTOM hold: state-changing ones return `dispatch_starved_waiting_for_serial_lane` at a fixed 240 s budget; read-only pass. Bypass `scripts/lib/git-api-publish.mjs`.
- "Modified vs local HEAD" != contested: local HEAD lags remote main — compare the worktree blob to REMOTE main (`GET /contents/<path>?ref=main`).
- `ci-status` ignores `rev`: an unpushed sha answers `unknown` + 422, query `gh api .../commits/<sha>/check-runs`.
- A red `npm run check` is usually FOREIGN (stale bake pins): read the failing line first. Re-bake `scripts/bake-heightfield.mjs --extent 256 --res 1 --sector 16 --bits 16`.
- `check-cache-keys.mjs` is shared: editing another transform's `BAKE_INPUTS_*` reddens `check` for every lane until the pin bumps in the SAME commit. Compute a pin from REMOTE committed blobs, reproducing the existing pin first.
- `scripts/check.mjs` parses TRACKED `src,client,apps,scripts,bin` only and runs EVERY gpu-free witness, printing `all <n> ran` plus the failing names — the whole gate, not a prefix. A witness must exit 0 AND print `RESULT: PASS`; one NOT in the gpu-free arm never runs.
- An absolute Windows path (`C:/dev/spoint/...`) in `scripts/*` is a CI-only ENOENT on ubuntu: resolve paths relative to the repo root.
- CI: completing jobs = `check` + `frame-time-coverage`; `frame-time` needs `vars.CI_GPU_RUNNER_ONLINE == 'true'` (else SKIPPED). Judge the newest CI-evaluated commit: `check-runs` on a `[skip ci]` bump is zero and reads as pass.
- CRLF: `core.autocrlf=true` only in SYSTEM config; `w/crlf` in `git ls-files --eol` = no diff.
- `.gitignore` re-includes `.gm/*` only for the memories, `disciplines/project`, witness-log, witness-out and pool-log paths.
- Untracking: `git_rm {cached:true}` + paths-scoped `git_commit {index_commit:true}`; `.git/index.lock` fails `git_commit`.
- Generated artifacts ship with source: `AppContext.js` -> `client/editor/sdk-typings.generated.d.ts` from the AppContext import closure; a pre-commit hook refuses a closure change without it.
- gm MCP is HTTP on `127.0.0.1:8787/mcp`, never retries, so a startup gap detaches it (`/mcp` recovers).
- `@spoint/ecs` resolves only via `@spoint/*`; the link can vanish mid-session (`npm run links`).
- Never `git worktree remove` a `scripts/worktree-setup.mjs` worktree (its node_modules junction deletes `node_modules/.bin`); use `scripts/worktree-teardown.mjs`.

## PRD rows and witness binding

- A PRD row id is a claim until `prd_list {"id":...}` resolves it. Never re-type a row id, body, dispatch id, witness id or sha. Row ids collide across sibling sessions, so a `prd-add` can overwrite another lane's row.
- `prd_resolve` needs a `witness_dispatch_id` in THIS project's `.gm/exec-spool/.dispatch-ledger.json`, or all four of `witness_exit_code`, `witness_output_sha256`, `witness_output_path` (RELATIVE to the root), `witness_ts`.
- `.gm/prd.yml` has a concurrent-lane lost update: an `ok:true` `prd-add` can later answer "prd id not found". Fix = re-add the id, then resolve. `git_finalize` on it is refused (`prd_foreign_rows`) while other sessions own rows.
- `prd.rs` reports `not_rerunnable` when a row's witness cites no existing `scripts/*.mjs|.js|.cjs` — a REPORT, not a regression; an inline-`exec_js` row stays completed but can never be re-verified.
- A truncated witness is a fabricated witness: never `.slice()` a log line you quote a number, flag or path from.

## Repo boundaries

- `design` ships as pinned CDN URLs in `client/{index,landing/index,editor/thebird-host}.html` + `scripts/bundle-client.mjs`; `vendor/*` = editing-only submodules.
- `apps/*` never imports `client/*` (singleplayer Worker resolves relative specifiers vs a virtual root); expose utilities on `engineCtx`. `apps/world/index.js` is the default-world authority.
- Node-only dynamic import specifiers stay opaque to esbuild/wrangler: IIFE, e.g. `src/sdk/EditorHandlers.js`. `edge/cf-do/spoint-do.js` imports `jolt-edge-init.js` BEFORE `WorkerEntry.js`.

## Debugging discipline

- A bug surviving a threshold change isn't fixed; a reported cause is a claim until instrumented. Fix at its own layer end-to-end — a second copy of the same check isn't a fix (`ShapeBuilder.js`).
- **Silent-no-op class**: codesearch the reader + enable bit first. Cases: `?noveg`, `__vdrsScale` (needs `window.__vdrs===true`), `?legacygl=1`, `u.fsCheap`, `perf-run.mjs inputReachedGame`, MICRO_JITTER. REFUTED: `--no-walk` — real reader `const WALK = !has('no-walk')` in `perf-run.mjs`; it empties the movement legs, so that arm measures an idle walk.
- **Silent-default class**: `Number.isFinite(x) && x > 0 ? x : literal` and `v ?? DEFAULT` turn invalid input into the default. Parse the whole record at ONE boundary and refuse there (`ColliderStreamer.js`, `src/stage/stageShapes.js`). `typeof v === 'number'` admits `1e999`.
- **No sentinel for absence**: "no ground" is a rejected variant (thrown `NoGroundHeightError`), never 0 or NaN; `null` compares as 0, so land paints at sea level, and a retain-previous closure seeded with 0 collapses height into seed. `guardedGroundHeight(where, heightFn)` takes TWO args.
- **Refusals carry a code, not prose**: `createClusterAssigner`, `assertWorld`, `StageLoader` (`StageConfigError.reasonCode`), `TickHandlerAOI` (`position|noPosition|unknownEntity`).
- **A module-level "report once" latch leaks across in-page rebuilds**: `PlanetFrame.guardedGroundHeight` deduped on a module-level Set, so a rebuilt `BrowserServer` never reported missing ground again. Put the latch on the returned closure.
- **A witness that mints ids as strings never reaches the parse boundary and pins nothing** — mint integers. A fixture that never stamps a sender fails every `handle()`, since `senderOf` reads the symbol `stampSender` writes.
- **A bare CLI flag parses to the string `'true'`**, so `Number()` yields NaN and disables the knob it sets.
- A witness needing the server to act on a client message passes `--params=multiplayer` (`?singleplayer` sees `players:0`). One `expect()` per measurement: a harness returning uncompared `{expected, got}` passes either way.
- One `gl.getError()` code covers distinct bugs (1282 = feedback-loop, sampler-type-mismatch AND insufficient-buffer-size): read the driver's console string. Live GL: `window`/`document` only via `page.evaluate()`; pin file:line via `addInitScript`.
- `witness-audit.mjs --gate` = gpu-free arm of `npm run check`, HIGH tier only, vs committed `.witness-audit-baseline.json`; fails on an absent check id or a higher count. LOW tier (`empty-catch`, `swallowed-error`) is advisory.

## Entry points

- `ctx.defineGameFSM(spec)` `src/behaviours/game-fsm.js`; `ClientMachine.js` xstate5 parallel, fallback `after:` 10 s gated / 45 s hard stop. `ctx.defineFire(spec)` `src/behaviours/fire.js` (wired in `src/apps/AppContext.js`, default off).
- Test relocation: `window.__spoint` + `MSG.TELEPORT` (0xc2 / ACK 0xc3, `src/sdk/Relocation.js`; no `EDITOR_TOKEN` = any client; >87 deg refuses).
- Client `ctx.state` = entity `custom` block (`AppModuleSystem.js`), not server app state: `ctx.state.<key> ?? literal` takes the literal forever. `engine.cam` = camera CONTROLLER, no `position`; read `engine.client.getLocalState().position`.
- Wireweave attach helpers run after awaits (host migration reassigns `client` in `app.js`): re-check at call time. `createServer()` is a per-call factory; `boot()`'s signals are process-global: stop with `RoomDirectory.stopAll`.
- A remote server's `netcode.profile` is named only when the client is a real `PhysicsNetworkClient`: boot that witness on `?connect=...&multiplayer=1`, else in-page `BrowserServer`.

## Fire

- Integer-only kernel `fireKernel.js`: decisions from `hash(seed,step,face,I,J)`; no float, `Math.random`, `Date.now`. Per-cell step = `burnCell`.
- Rain smothers, doesn't eat fuel: a suppressed cell still burns `burnRate`, pushes no heat, spots nothing. Intensity 0..1 -> roll byte 255 via `rainPerIntensity` (`fireSpec.js`).
- `ctx.navCostAt(x,z)` = 8 burning / 2 charred (`_fireNavByRuntime`); `canSee` smoke-gated at depth >= `smokeBlockDepth`. Wind = weather BASE + `hash(seed,step)` gust, clamped +-16/axis; `snapshot().wind` carries BASE only.
- Per-cell initial fuel isn't recomputable in the kernel: a per-tile array in `snapshot()`/`restore()` joins `TILE_ARRAYS` + VERSION bump.
- A tampered keyframe is rejected at DECODE. `G` = ignition step mod 256, not age; IGNITE_AREA kind 5. `fireKeyframe.js` raises `[fireKeyframe]`; `rewindTo` restores one and verifies against `counters`, never `delta`, which at a boundary rolls back the step BEFORE it.
- A fire record promising work with no sampler is refused at construction (`src/behaviours/fireTerrain.js`): `firebreaks.kinds` defaults `['road','river']` while `kindAt` is null; `firebreaks.water` defaults true while `heightAt`/`seaLevelAt` are null.

## Planet-wide multiplayer

- One server world per cluster, own flat chart. Jolt heap fixed at 134217728 B (`JOLT_WASM_HEAP_BYTES`, `src/shared/clusterConfig.js`), never grows; over it `new J.JoltInterface` raises `Aborted(OOM)`.
- `maxContactConstraints` under requirement drops contacts silently; `maxBodies` under population makes Jolt return body id 0, so overflow bodies share a map key and `destroy()` aborts wasm. Assignment is pure, hysteretic, 2-4 Hz.
- Collider rings: `DEFAULT_MAX_CENTERS = 192` for BOTH trunk + rock streamers; rings per connected player, never centroid; eviction farthest-first, graded by `classifyRings` (`ColliderStreamer.js`).
- Clusters are OFF in every shipped world (`apps/world/tps-game.js`, `apps/world/tutorial.js` declare `clusters: { enabled: false }`). The world-def parser makes the mismatch unrepresentable both ways (`world-clusters-enabled-without-planet-radius`, `world-planet-radius-unreachable`); `terrain: true` is refused because `worldDefParse` and `resolveTerrainConfig` read it oppositely.
- Flat AOI is HORIZONTAL (`getRelevantEntitiesHorizontal`, chosen when `planetRadius <= 0`): zero vertical slack.
- `StageLoader.js` throws when a radius is declared without enabled clusters and resolves config on EVERY load: six `ClusterConfigError` codes can throw at boot and on hot reload.

## Chart re-anchor

- Chart-local server holders migrate via `src/sdk/chartState/` (`attachServerChartMigrators(ctx, service)`). Re-anchor = change of basis, not rotation: position/velocity/forward invariant. CHART_REANCHOR = 0xc6.
- Flat chart tilt is fixed by shrinking the chart: `CHART_ANCHORS_PER_FACE = 32`. `CHART_REANCHOR_ANGLE_DEG` (28 / 14) must exceed `createChartAnchorLattice`'s worst angle or the anchor thrashes; hysteresis 0.75. ONE chart per world; separation Delta puts players at Delta/2, walkable iff `terrainTilt + Delta/2 <= 45 deg`.
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
- Physics frame cost is `physics.step` (~0.331 ms/frame); LOD sweep + budget under 7%; noise +-0.06 ms per call.

## Terrain and colliders

- `solveSurfaceY` tolerance absolute `1e-4` (`SURFACE_SOLVE_TOLERANCE_M`, `PlanetFrame.js`), 64-eval cap, throws `SurfaceSolveError`; past 63.6 km it returns `-(R+anchorHeight)` with no throw.
- A sampled vertex height must be a function of the vertex, not of the walk: `sampleTerrainGridChunked` seeded each solve from `prev + (prev - prev2)`, and the 1 mm `HEIGHT_SNAP_PER_METRE` is 10x coarser than the 1e-4 tolerance (raw spread 0.000142 m, snapped 0.001000 m). Fix: start every solve from `renderYOnSphere(r2, 0)`; landed in `HeightfieldStreamer.js`. REFUTED too: 16-bit per-field quantization as the seam cause — `addHeightField` copies into wasm and never writes back.
- Baked heightfield FAIL-LOUD (`TerrainPhysics.js`): absent = silent CPU fallback; unreadable/truncated/bad-magic/stale-code throw `[baked-heightfield]`; `hashVersion`/`terrainKey`/`chartEpoch` mismatch warns + falls back.
- No terrain is FATAL: `ServerAPI.loadWorld` rethrows `[terrain] world "<id>" has no terrain`; every caller stops its server first. `elevationAtLocal(frame,x,y,z)` = exactly `|p|-radius`; `ctx.terrainHeightAt` is NOT that.
- `PlanetFrame.groundHeightLocal` caches 4096 direct-mapped slots keyed by EXACT `(x,z)` + chartEpoch; hit rate ~0.3% while walking, so a bigger cache buys under 0.07 ms/frame.
- `terrain.glsl`'s `snoise3`/`vnoise2`/`seaHash`/`hpfSample` take the in-cell fraction as `P-floor(P)` from ONE `floor`. Server terrain collider = ONE fixed-anchor local tangent plane (`anchorDir` default [0,1,0]): can't represent directions past ~87 deg from anchor.
- `gl-render.js sampleGroundM` is fire-and-forget async, so each call returns the PREVIOUS call's height; non-rAF callers use `sampleGroundMSync`, which poisons the next async read.
- `VegPlacement.js`/`RockPlacement.js` read climate before `surfaceOfCell` only when `climateUsesLocalXZ !== true`. Veg density must gate on painted snow, else surviving grass weight roots trees. Slope caps differ between `VegPlacement` and `GrassPlacement` (`SLOPE_MAX` 0.6 vs 0.9).
- REFUTED: `PlacementChart.js radialSlopeAt`'s 2-tap forward difference — the gradient crosses `SLOPE_MAX`, flipping gate decisions. Skipping a three.js attribute upload is safe only because a buffer is seeded from the whole CPU array on creation.

## Grass distance-density

- `GRASS_DENSITY` + `grassBladeEdgeM` (`src/terrain/GrassPlacement.js`) are the single source of the law: `client/core/Grass.js` selects on it and BOTH `GrassTSL.js` and `GrassMaterial.js` mirror it in the vertex stage. Editing one side alone desynchronises the fade from the instance set with no error.
- A blade's rank `q` is the coin that decided whether it exists, divided by the cell density it was drawn against: uniform on [0,1) and stable for the blade's life, so `q >= f(d)` removes exactly the fraction `f(d)` and which blades are removed is never re-chosen as the player moves. It costs no extra hash, which is why it is that draw and not a new one.
- `f(d) = (FULL_R / d) ** P` is what makes the surviving population grow as R ** (2 - P) instead of R ** 2; P = 1 would make every extra metre of draw distance cost the same blades as the metre before it. Inside FULL_R the keep fraction is 1 and the fade is exactly 1, so the near band is untouched by construction, not by tuning.
- The fade has to be shader-side: the CPU re-decides only every `LOD_REVISIT_STEP_M` (4 m) of travel, so a CPU scale fade steps by a large fraction of a blade's height per step. The CPU therefore holds each blade from `LEAD_M` before its own edge — `LEAD_M` must exceed `LOD_REVISIT_STEP_M`, or a blade arrives already visible and pops — and the shader grows it over `FADE_M` metres of the approach.
- `wind.uGrassRing` no longer carries the ring radius; it carries `EDGE_CAP_M = ringRadius - EDGE_M`, the distance at which the outermost blades' fade reaches zero. The old `1 - smoothstep(0.55 * R, R, d)` height squash is gone, so grass is now full size out to `EDGE_CAP_M - FADE_M` rather than to `0.55 * R`.
- Placement is chunk-granular and the law is not, so a bigger ring places about twice the blades it keeps; `scripts/grass-distance-density-fade-witness.mjs` measured `updateMsPerQuietFrame` 1.03 -> 1.71 ms. Judge a ring change on that number, not on the instance count alone.

## Netcode and wire

- Prediction suppresses only the blocked DIRECTION: `_reconcile` (`PredictionEngine.js`) derives `wedgeNormal` from commanded-vs-achieved motion, else `-velocity` when stopped while commanding; `characterStep.js` projects out that component alone.
- `msgpack.js` `WIRE_STRUCTURES[1]` lists exactly the 10 keys, in order (`seq,tick,serverTime,players,entities,removed,delta,dots,me,chartEpoch`), of `TickHandler.js _packPayload`. msgpackr 2.0.4 writes -0 as `0x00`; `patch-deps.mjs` excludes -0 from both integer tests. Raw ws clients mirror `COALESCE_SENTINEL` 0xff: `0xFF` then `[uint32 LE length][msgpack]`.
- Wire v3 player record: 8 fields in a 22-byte bin; `[inputSequence, inputBuffer, groundNormal]` ride a per-recipient `me` block, so snapshots pack per recipient. `getSnapshot()` keys on `_version === _snapshotVersion` alone.
- `PhysicsNetworkClient.connect()` REJECTS with a named `TransportConnectError`, never `connected:false`; retry belongs in the caller (`_doReconnect`). `err.reason` is stable: `websocket-unavailable`, `-closed-before-open`, `connect-superseded`.
- Prediction lead capped by `MAX_PREDICTION_LEAD_STEPS` = 16, and penetration is FLOORED by it: a `kinematic` wall hands the client NO plane (`wallPlaneTicks === 0`), so it cannot know the wall exists until the server touches it. Bound prediction error in STEPS of travel, not metres — metre bounds are box-load sensitive.
- `SnapshotGroupPlanner`: groups = `ceil(viewers*perViewerMs/(budgetMs-fixedMs))`; budget = tick period * `SNAP_COST_HIGH_FRAC` 0.35. `relevanceRadius` is set by worlds (`src/presets/tps.js` 200, `apps/world/construct.js` 100); `getRelevanceRadius` falls back to 0 only where omitted.
- Lockstep: rollback is input-capped, so measure by depth, not rate (`maxRollbackTicks` 12); `maxRollbackTicks + inputDelayTicks >= windowSize` throws; `inputDelayTicks` above `INPUT_RETAIN_TICKS` (240) throws at construction.
- A socket becomes a player by MIGRATE, RECONNECT, or silence past the MIGRATE-peek grace (`ServerHandlers.js onClientConnect`, 50 / 1500 ms). A silent probe joins as a phantom, so probes use `?probe=1`; never answer an unresolvable RECONNECT with INVALID_SESSION and leave it open.
- Migration keeps the old transport as fallback owner. Router- and worker-minted ids are separate fields (`routerPlayerId`/`localPlayerId`): one shared field made both misses silent.
- Authoritative path: prediction off by default (`?predict` only). `processPlayerMovement` takes ONE input per tick, catching up only while `inputs.length > INPUT_BUFFER_CATCHUP_DEPTH` 8. A 0 or NaN checksum interval makes `isChecksumTick` false every tick, so `DesyncDetector` silently passes.
- Health is attested, not defaulted: `readHealth` returns a frozen `{known:false}` whose `hp` getter throws, so an omitted health must not read as full.

- MSG ids in `src/protocol/MessageTypes.js` need only be unique: `nameMap` throws at module load on a duplicate (`:140-144`). Declaration order carries no meaning (`PEER_RTT_TABLE` 0xc1 sits between 0xac and 0xad, `:96-97`).

## Rendering

- `WebGPURenderer` is DEFAULT (`?legacygl=1` opts out); unavailable WebGPU retries `forceWebGL=true` before legacy, so TSL is the only shader path. `ClusterLodMesh._render` fires once PER GROUP per frame: keep the `_lastRenderFrame===frame` early-return.
- **A WebGPU pipeline that fails validation dispatches nothing and surfaces nothing**: three caches the wrapper before the compile result, then `draw()` returns early on it and nothing resets it, so the shape stays broken for the process lifetime; errors arrive only async via `device.onuncapturederror` -> `renderer.onError`. Mitigation `installStuckPipelineRecovery` (`client/core/SceneSetup.js`): repeated `/RenderPipeline|CommandBuffer/` errors in a window force a scene-wide `material.needsUpdate`.
- Veg LOD: `WebGPULodInstancer`'s oracle mirrors `updateLOD`; `lodEye` refreshes only after 0.5 m (`LOD_REEVAL_MOVE_SQ`). A leaf instancer is a SATELLITE of its branch (`opts.host`).
- Default terrain FS is TSL, not `terrain.glsl`: `TerrainBackdrop.js` imports `mapspinner/src/tsl/planet-tsl.js` when `isWebGPU`. `terrain.glsl` = legacy path + height-parity SoT (`gen-height.mjs`); deleting it needs a new SoT + generator. Every discard in it stays inside `#ifdef _WATERPASS_`.
- `terrain-lighting-tsl.js` gates `sky.marchRadiance` on `apGate > 0`; Terrain `renderOrder` 10. The always-paid water cost is the VERTEX stage (`WATER_DRAWS_BEFORE_OTHER_TRANSPARENTS` -1 only orders inside the transparent list). `side = DoubleSide`, so backfaces are never culled (s7).
- TSL `select` outside `uniformFlow` emits a real `if/else` (`ConditionalNode`), not a ternary: both sides are NOT evaluated. VDRS has no live consumer (zero `vdrs` under `packages/mapspinner/src/tsl`).
- `invertAcesFilmic` must NOT end in `max(x, 0)`: saturated blue inverts out of AP1/ACES gamut and clamping mis-encodes it. Rendered sea = sphere R == `PlanetFrame.waterlineLocalY` to 1 cm; waves ZERO-MEAN. `?legacygl=1` flips terrain hashVersion, so a legacy run isn't comparable to TSL.
- `ShadowPipeline.js forceUpdate(movers, eye)` dirties only the cascades whose camera-distance band, widened by `CASCADE_BLEND_M` plus `SHADOW_REDRAW_CASTER_HEIGHT_M / tan(sun elevation)`, contains a moved caster; without movers it dirties all. `cascadeCount` clamps to 1 when `sun.castShadow===false` (cascade 0 IS the sun). `CascadeShadowSelectTSL.js` selects by `positionWorld - cameraPosition`, cross-fading over `CASCADE_BLEND_M` 4 m.
- **Cascades 1..n are inert**: `createShadowPipeline` builds them as `DirectionalLight(0xffffff, 0)` with no intensity, while three's node lighting folds a shadow into the light's own contribution (`shadowColorNode = colorNode.mul(shadowNode)`), so they render and cannot darken one pixel. The sun's `shadowNode` is `mix(1, shadow, w)`, `w` -> 0 at cascade 0's extent, so **no shadow exists past it** (60 m at default `extent 60`); s14.
- Vegetation `InstancedMesh2`: `sortObjects` stays false with LODs; `CullFreeze.js setInstancedCullAuto` sets `autoUpdate` on parent AND every LOD level. `model-pool.js` drains must allow >=1 unit/frame or a zero budget deadlocks. **No millisecond slice budget survives in `Vegetation.js`**: a species build yields at every phase boundary (generate / LOD chain / materials) and the prewarm slice IS the chunk, so the longest block is one unit of work (worst chunk 5.7 ms, warm species rebuild 2.2 ms). `speciesLodChain` in `VegetationBuild.js` caches the finished LOD chain beside the species template, so a landscape change clones it (cold 87.2 ms worst / 621.5 ms total over 15 species -> warm 2.2 ms / 20.2 ms) instead of re-running meshopt on identical input; s11.
- QualityGovernor drives only GOVERNED_KNOBS (ssao, bloom, ssr, vegLeafOff, maxLevel, splitFactor) and throws if a driven key is in RESOLUTION_KEYS (`dpr*`, `vdrs*`, `threeVdrs*`, `fsr1*`, `halfResWater`, `bloomResolutionScale`): no pixel doubling. `qualityGovernor` defaults TRUE and is no longer hitch-blind: an overrun latch sheds a tier within `HITCH_RESPONSE_BOUND_FRAMES` (100 ms in 1 frame), and the smallest SINGLE hitch it can see at all is 34 ms. The 17.67-33.34 ms band is not governed by lowering `hitchAboveMs` -- that trips the latch on every marginally-over frame and oscillates -- but by a counted excursion: a frame over `LOWER_ABOVE_MS` is one excursion and `EXCURSION_TRIP_COUNT` (8) of the last `EXCURSION_WINDOW_FRAMES` (12) must be excursions, so a sustained 25 ms overrun is answered after 8 frames / 200 ms instead of 60 frames / 1500 ms, while one over-budget frame (one excursion out of 12) cannot shed. `state.shedCause` names which path took the last step (`hitch|excursion|window|none`); without it a band shed reads as a 30-frame-window one, which is the path that did NOT act.

## Client and app runtime

- HUD `applyDiff(container, hudVdom)` (`AppModuleSystem.js` renderAppUI) is 4 Hz, not per frame, and already diffs in place: an unchanged subtree costs 0 writes, a one-field change 1 text write.
- webjsx (`node_modules/webjsx`, used by `client/AppModuleSystem.js`) has no `newVNode instanceof Node` branch, so a real DOM node in a vdom throws inside `createDOMElement` and `renderAppUI`'s try/catch silently freezes the HUD; `anentrypoint-design` re-exports vendored `vendor/design/vendor/webjsx`, which has that branch.
- `_buildWorldScenery` is joinable: boot adopts a running build. `app.js animate()` returns early while `window.__warmupInFlight`; never park a wait inside warmup.
- Client `WORLD_DEF` from `sendWorldDefAndModules` has `entities` STRIPPED and carries `_modelUrls`: derive world-entity facts from `_modelUrls`.
- Hot reload releases ctx via `AppRuntime._releaseAppContext`; `update()` keeps running with a torn-down ctx unless `_updateList`/`_rebuildCollisionList` are rebuilt. `AppRuntime._attachApp` does `apps.set` BEFORE awaiting `setup()`.
- `src/apps/CustomVersion.js`: `Reflect.set` is a deliberate raw write; a read must not reach the set trap and bump `_customV`.
- Spawn: `holdSpawnUntilGrounded` gates release on `terrainFieldMissingAt`/`coversPosition` (max `SPAWN_HOLD_MAX_MS=20000`); `staticCollidersPendingNear` is true whenever `AppRuntime._pendingTrimeshBuilds.size > 0`.
- Respawn clearance is shared: `AppGameplay.js pickSpawnPoint` + tps-game use one `footprintBlockers` sampler (17 columns; surface > `MAX_FOOTPRINT_INTRUSION_M` 0.15 m above a column bottom = `intruding`). `apps/tps-game/respawn-clearance.js` exports no `spawnClearanceMarginM`.
- `BrowserServer.js`: `_lastTodSync` + `_deliveredWorldFingerprints` are MODULE level, so stall recovery + HostMigration rebuild a fresh BrowserServer in the same page. Singleplayer worker identity comes from `INIT.worldName`. `FloatingOrigin.js update()` does `camera.position.set(0,0,0)` on rebase, not `+= -delta`.
- rAF is throttled or stopped in a HIDDEN tab; `MessageChannel` `postMessage` is the yield primitive (no 4 ms clamp, no hidden-tab throttling).
- **client/hud IS node-witnessable**. A `node:module` `registerHooks` resolve hook redirects bare `anentrypoint-design`, the dynamic `wireweave`/`xstate` imports and root-relative `/src/...`.

## Measurement and witnessing

- Measured figures, refutations and instrument/adapter notes: `docs/measurement-figures.md`.
- Per-pass GPU timings (`p50Ms`,`p95Ms`,`avgMs`) are INVALID as GPU-bound measures (lane a368d997, s0); a 0 duration is UNWRITTEN (65.5 us granularity). AMD iGPU `--gpu-passes --extra=gputime=1 --backend=webgpu` works only after `npm run build:client` and is INVALID too.
- rAF-to-rAF frame wall is vsync-quantized: every median is a multiple of the 16.68 ms refresh period, so a `maxLevel` ladder resolves only as a 60/30 fps ordinal. Main-thread CPU (ThreadTime) is NOT quantized and is the instrument that resolves level cost.
- No `perf-run.mjs` instrument unlocks vsync (flags live only in `frame-time-gate.mjs` behind `UNLOCK_RAF`). `scripts/maxlevel-crossover-witness.mjs` is the ladder instrument that does unlock it (`--lock-raf` opts out) and refuses a run whose rung medians are still on the k*16.68 ms grid, so an arm that silently stayed vsync-locked fails instead of reporting the refresh divisor as a measurement.
- **A spot-sampled maximum under-reports**: a max sampled once per server tick only lower-bounds it — measure per predicted step. `prediction-wedge-witness.mjs`: exhaustive penetration 0.0825..0.39667 m against a sanctioned clear-lane lead 0.41452..1.22937 m (ratio 0.163..0.802); `APPROACH_PEN_TOL_M`/`TRANSIENT_PEN_TOL_M` are 0.6, priced against `PEN_LEAD_FRAC` 1.0 x that lead, because 0.2/0.25 sat BELOW the lead the same witness sanctions. Non-vacuous: `--probe=wallpush --probeOvershootM=1` reads 2.4 m, 3.9..5.8 x the lead.
- **A nearest-surface probe caps its own reading at HALF the probe thickness**: past the mid-plane the far face becomes the nearest one and the number turns back down (`PEN_M` / `WALL_HALF_THICK_M` 3, `prediction-wedge-witness.mjs`) — a wall thinner than twice the expected penetration caps the measurement.
- **Quality and fidelity are two different claims**: a knob that sheds a tier works as designed even when the picture is unacceptable; verify any GOVERNED_KNOB or LOD/impostor threshold change **visually, per tier and across near/mid/mesh-far bands** (near-range leaf/branch loss is invisible to frame time) and never buy frame time by widening a distance band.
- Pin each GPU arm's adapter: `vendorGpuArgs(vendor)` adds `--use-adapter-luid=0,<luid>` (`gpuLaunchArgs()` doesn't); Chrome ignores an unresolvable LUID while reporting accelerated, so assert `window.__rendererInfo`. `gpulock` serializes the adapter, never the CPU; `host-contention.mjs` cannot see GPU-side contention.
- Decide perf rows on counted work units: a never-incremented counter is a silent pass (`vegProfile.meshInstances` is absent on `WebGPULodInstancer`). Authoritative draw count = `drawsInstrument.authoritativeField` (`wgpuDrawsPerFrame`/`glDrawCallsPerFrame`).
- Toggles: `?lightplanet` stubs the planet but keeps the height sampler + foliage; `?veg=none`, `?nograss`, `?norocks` are real.
- `perf-run.mjs`: `?gpuhide=`/`?gpuab=<name>`, `?gpuabms=<ms>`, `--knob=<key>=<value>[,...]`. Keys are registry `key`s verbatim (`maxLevel`, not `__maxLevel`); one bad key fails the run. Limits: `maxLevel` 2..22, `splitFactor` >= 0.05.
- `dprAuto` defaults `false` (`RenderControls.js`); measuring arms pass `--knob=dprOff=true`. `halfResWater` reads as `=== true` (`gl-render.js`), so unset = OFF.
- WebGPU parity: a region matches iff cross-renderer meanAbs/channel <= `K` x the same-renderer noise floor (`scripts/tsl-parity/analyze.mjs`); establish the same-code floor first (s8).
- CDP (`cdp-browser.mjs`): an init script `(() => { ... })` is a discarded EXPRESSION — end it in `())`; `page.evaluate(string)` takes an EXPRESSION. Assert `installed === true`, else an absent counter reads as a measured zero.
- A hook that never fires in the main pass is a broken instrument: assert `mainRenders > 0`. Classify a shadow draw by `light.shadow.camera === camera` with `onBeforeRender` patched on the prototype that OWNS it.
- A witness with a fixed scratch dir must `rm` it at start. `edge-collider-draco-witness.mjs` rewrites tracked `apps/tps-game/*.glb` in place: never run it in a gate.
- **A `?singleplayer` walk arm does not translate the player**: the authoritative player never advances and the client is corrected to spawn every server tick, so 12 s of a commanded 7 m/s (84 m of route) nets 0.38 m as a sawtooth snapped back to spawn, while `?multiplayer` nets 37.72 m monotonic with no snap-back. `perf-run.mjs --no-walk` (`WALK = !has('no-walk')`) is the INTENDED idle arm; the default arm keeps its movement legs and fails at the translation, so a default walk window has to be floored, not assumed. Floor a walk window on its EXCURSION from the window's first sample (`walkExcursion` / `walkFloorFailure` in `scripts/lib/walk-translation.mjs`, `--min-walk-moved`, 10 m), never on path length and never on net: summing |p[i]-p[i-1]| counts the snap-back as travel, so a rubber-band reports 58 m of path over 0.99 m of ground, and `perf-run.mjs`'s four-leg KeyW/KeyD/KeyS/KeyA route nets ~0 while genuinely walking. `getLocalState().position` is an ARRAY `[x,y,z]`; reading `.x` off it is NaN, and `asXYZ` is the read that accepts either shape.

## Security

- Re-run the dependency scan on any fresh or updated `node_modules`.
- `SESCompartmentEvaluator.js` is the only untrusted-app evaluator and fails closed (`SandboxUnavailableError`); `StaticHandler` enforces path containment + COEP `require-corp`. A failed `import('ses')`/lockdown throws: ses is only in optionalDependencies.
- `authCompare.js timingSafeTokenEqual` self-compares (`bufA,bufA`) on a length mismatch so token length isn't leaked: don't simplify it away.
- Benign exec surfaces, never flag as malware: `lang/spoint.js`, `mapspinner/planet.html`, `scaffold.js`, `cdp-browser.mjs`.
- Witness CLIs taking `--module=<path>` load that path as code: point them only at trusted files.
