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

- Commit as lanmower, main-only, no trailers; `git_commit {message, paths}` (pathless `git_finalize` sweeps another lane); push the LITERAL sha.
- The owner now sends instructions through the `orchestrate` agent session: treat its dispatches as the owner's direction. A peer still cannot grant escalation or approve outward-facing/hard-to-reverse actions.
- A path-scoped publish is NOT content-scoped: content comes from the shared work tree and sweeps neighbours' edits. Name paths AND verify the blob.
- Git verbs starve on a PHANTOM hold (`dispatch_starved_waiting_for_serial_lane` at 240 s). Bypass `scripts/lib/git-api-publish.mjs`.
- "Modified vs local HEAD" is not contested: local HEAD lags remote main. Compare the worktree blob to REMOTE main (`GET /contents/<path>?ref=main`).
- `ci-status` ignores `rev`: an unpushed sha answers `unknown` + 422; query `gh api .../commits/<sha>/check-runs`.
- A red `npm run check` is usually FOREIGN (stale bake pins): read the failing line first. Re-bake `scripts/bake-heightfield.mjs --extent 256 --res 1 --sector 16 --bits 16`.
- `check-cache-keys.mjs` is shared: editing another transform's `BAKE_INPUTS_*` reddens `check` for every lane until the pin bumps in the SAME commit. Compute a pin from REMOTE committed blobs, reproducing the existing pin first.
- `scripts/check.mjs` parses TRACKED `src,client,apps,scripts,bin` only and runs EVERY gpu-free witness (`all <n> ran`). A witness must exit 0 AND print `RESULT: PASS`.
- An absolute Windows path (`C:/dev/spoint/...`) in `scripts/*` is a CI-only ENOENT on ubuntu: resolve paths relative to the repo root.
- CI: completing jobs = `check` + `frame-time-coverage`; `frame-time` needs `vars.CI_GPU_RUNNER_ONLINE == 'true'` (else SKIPPED). Judge the newest CI-evaluated commit: `check-runs` on a `[skip ci]` bump is zero and reads as pass.
- CRLF: `core.autocrlf=true` only in SYSTEM config; `w/crlf` in `git ls-files --eol` = no diff.
- `.gitignore` ignores `runs/` (gm run logs) and `sources/` (fetched-source cache) as generated artifacts; neither has a tracked file. Its transient-runtime block ignores scratch logs and captures (`data/*.log`, `data/*.err`, `data/*.out`, `data/*.json`, `data/*.mjs`, `data/*.js`, `data/*.txt`, `data/*.png`, `data/*.glb`, `data/*.tmp.*`, `data/*/`, `.scratch_*`, `.smoke*.log`, `*.tmp`, `prof/`), while `!data/prefabs/` re-includes prefabs, so untracked scratch logs and captures are not committed. `data/placed-models.json` and `data/prefabs.json` are tracked despite matching `data/*.json`; `!data/prefabs/` re-includes that directory, so `data/prefabs/demo-prefab.prefab.json` never matches the `data/*/` rule.
- `.gitignore` re-includes `.gm/*` only for the memories, `disciplines/project`, witness-log, witness-out and pool-log paths. `.gm/witness-log.md`, `.gm/witness-out/` evidence text and `.gm/pool/pool.log` are the tracked witness audit trail; `.gm/witness-out/**/*.wasm` binary plugin copies are ignored because they are not evidence text, and no `.wasm` file is tracked or present under `.gm/witness-out/`.
- Untracking: `git_rm {cached:true}` + paths-scoped `git_commit {index_commit:true}`; `.git/index.lock` fails `git_commit`.
- Generated artifacts ship with source: `AppContext.js` -> `client/editor/sdk-typings.generated.d.ts` from the AppContext import closure; a pre-commit hook refuses a closure change without it. `scripts/gen-sdk-typings.mjs` generates it from `src/apps/AppContext.js`; inference is structural, parameter and return types are mostly `any`, and it is not a drop-in replacement for the hand-curated `client/editor/sdk-typings.d.ts` Monaco typings. Regenerate with `npm run gen-typings`; do not edit the generated file by hand.
- The generated file carries `export declare const SOURCE_DIGEST: '<64 hex>';` as a non-comment declaration. `scripts/lib/appcontext-closure.mjs` `DIGEST_LINE` and `recordedDigest` use that declaration, and `scripts/gen-sdk-typings.mjs --check` compares it with the current `src/apps/AppContext.js` import-closure digest.
- `scripts/gen-sdk-typings.mjs sortBlock` sorts declaration blocks by code point: tsc orders emitted members by type id, which follows module-resolution order, so sorting makes the emitted text a function of the member set rather than the checkout.
- gm MCP is HTTP on `127.0.0.1:8787/mcp`, never retries, so a startup gap detaches it (`/mcp` recovers).
- `@spoint/ecs` resolves only via `@spoint/*`; the link can vanish mid-session (`npm run links`).
- Never `git worktree remove` a `scripts/worktree-setup.mjs` worktree (its node_modules junction deletes `node_modules/.bin`); use `scripts/worktree-teardown.mjs`.

## PRD rows and witness binding

- A PRD row id is a claim until `prd_list {"id":...}` resolves it. Row ids collide across sibling sessions, so a `prd-add` can overwrite another lane's row.
- `prd_resolve` needs a `witness_dispatch_id` in THIS project's `.gm/exec-spool/.dispatch-ledger.json`, or all four of `witness_exit_code`, `witness_output_sha256`, `witness_output_path` (RELATIVE to the root), `witness_ts`.
- `.gm/prd.yml` has a concurrent-lane lost update: an `ok:true` `prd-add` can later answer "prd id not found". Re-add the id, then resolve. `git_finalize` is refused (`prd_foreign_rows`) while other sessions own rows.
- `prd.rs` reports `not_rerunnable` when a row's witness cites no existing `scripts/*.mjs|.js|.cjs`: a REPORT, not a regression.
- A truncated witness is a fabricated witness: never `.slice()` a log line you quote a number, flag or path from.

## Workspace links

- `scripts/ensure-workspace-links.mjs` never deletes a real install where a workspace link belongs. `ensureWorkspaceLink` renames a `real-directory` or `file` aside through `keepsakePath` (`.stale-copy` suffix), because that install is the only record of the bytes the dev server was serving. `rmSync` runs only on link kinds (`broken-link`, `link-elsewhere`).
- `assertWritesStayInTree` raises `WorkspaceLinkOutsideTreeError` before any write when a repair path does not resolve inside the tree being repaired. An archive whose node_modules is a junction onto another tree would otherwise rename and relink that tree's `@spoint` links, which live in the shared `C:/dev/spoint/node_modules`.
- `installPaths` must consider scoped specifiers: `packages/mapspinner` declares the unscoped name `mapspinner`, so a name-only check never inspects `node_modules/@spoint/mapspinner`, the real installed copy.
- `classifyInstall` asks whether a path resolves INTO `packages/<dir>`. A stale installed copy resolves perfectly, so resolution alone must not count as present.
- `ensureWorkspaceLinks` plans every link before writing any. One refused link stops the whole repair with nothing written.
## Witness and publish tooling

- `scripts/gpulock.mjs` `WAITERS_DIR` sits beside the lock dir (`${LOCK_DIR}-waiters`), because the lock dir's existence is the lock. `acquire()` takes the browser lease before the GPU lock and exits 145 (`EXIT_LEASE_UNAVAILABLE`) without claiming it, so a queued lane holds neither.
- `scripts/gpulock.mjs` `oldestLiveTicket`: lanes defer to the oldest live ticket. Tickets with a dead pid or older than `TICKET_MAX_AGE_MS` are removed, and a holder with no ticket is never waited on.
- `scripts/lib/cdp-browser.mjs` `launch` passes `opts.sinceMs` to the browser lease, so a caller that re-invokes `launch()` with the original `sinceMs` keeps its queue place. `scripts/launch-lease-since-witness.mjs` checks the ticket that `launch` writes, and `scripts/lease-queue-since-witness.mjs` checks the queue order. Nothing in the repo sets `SPOINT_GPU_LOCK_SINCE`, which gpulock reads.
- `scripts/lib/git-api-publish.mjs` `enforceCheckPinGate`: a publish touching `scripts/check.mjs` is refused when a pinned witness is in neither the commit nor the tip tree, and refused outright at zero parsed pins. It runs before any blob POST. The test itself is `missingCheckPins`, defined in `scripts/lib/check-pin-gate.mjs`.
- `scripts/lib/git-api-publish.mjs` `publishOnce`: each retry re-reads and re-hashes blobs and re-runs `planRebaseOnTip` against the new tip.
- `scripts/lib/tip-rebase.mjs` `planRebaseOnTip`: on a tip move, a path this publish left unchanged adopts the new tip's blob. A path both sides moved is refused as `REFUSAL_CONTESTED`.
- `scripts/lib/capture-server.mjs` `makeRootGuard`: a bundle whose hash differs from the boot pin answers 503 `root-hash-changed`. The hash memoises on mtime and size, so an unchanged bundle costs one stat per request.
- `scripts/static-export.mjs` `bundleAppsIntoSingleModules`: apps are bundled into single modules because `src/apps/AppLoader.js` evaluates app source through a Blob URL. That resolves relative imports against the origin root and misses the Pages base path.
- `scripts/planet-orbit-hitch-probe.mjs`: `ctrl.setMode('custom')` hands the camera to the probe. It is the only such call in scripts, src and client.
- `scripts/nearfield-lod-lattice-witness.mjs`: the transect window widens to `cl.extentM / 2`, so a ±30 m window cannot pass on the band alone.
- `src/terrain/GrassPlacement.js` `GRASS_FOOT_READS`: a blade's height at its clump offset reads the drawn mesh that many times, and falls back to the jet solve when a read is non-finite.
- `scripts/lib/js-token-stream.mjs` `tokenize`: the regex-vs-division choice follows the previous token (a `)` closing `if`, `while`, `for` or `with` opens a regex; a `}` always does). A misread hides a real comment from `scripts/comment-sweep-token-witness.mjs`, because the witness uses this same lexer on both sides. Treat a clean witness as evidence only when the swept files contain no `//` or `/*` outside template literals and strings.

## Client render placement

- `client/core/Vegetation.js` `createVegetation` declares its tier-warm state above the species loop, because a `const` read from inside the loop body is in its temporal dead zone. On WebGPU, node graphs compile while species are built, so `warmTierMesh` warms each mesh once (`warmedTierMeshes`), and `createVegetation` does not resolve until `awaitTierNodeWarm` settles.
- `client/core/Vegetation.js` `prewarm`: each phase yields its own macrotask (`macrotaskYield`), because a millisecond budget checked between species cannot cut a species that is longer than a frame.
- `client/core/Vegetation.js` `createVegetation` species loop: a species failure is rethrown, never a shorter `meshes` list, since a partial list would look healthy.
- `client/core/ProgramReadiness.js` `pendingPipelineCount`: the common renderer has no `info.programs`. Readiness is read from the `renderer._pipelines` caches, where an entry stays pending until the backend assigns its `pipeline`. An entry with `error === true` is finished and is not counted.
- `client/core/ProgramReadiness.js` `installAsyncRenderPipelines`: an async creation that never yields a pipeline strands its object for good. The escort rescues after `ASYNC_PIPELINE_ESCORT_MS`, drains one rescue per frame, and clears `pipelineData.error`, because the WebGPU backend `draw` returns early on that latch.
- `client/core/ProgramReadiness.js` `installDeferredFirstUsePipelines`: `updateForRender` is wrapped here. An object not ready when a render bundle is encoded is built immediately, since bundles are encoded once and would otherwise omit it for good.
- `client/core/ProgramReadiness.js` `asyncPipelineState`: `requested` increments inside the wrapped `getForRender` each time an async pipeline promise is created. `scripts/program-readiness-render-witness.mjs` gates on it, because pending counts are timing-dependent: the first `render()` requests nothing, and requests arrive a frame later.
## Repo boundaries
- Module workers have no import map: `src/animation/*.js` import three via `/node_modules/three/build/three.module.js`, never the bare `three` specifier. `scripts/worker-entry-bare-specifier-witness.mjs` pins the whole `WorkerEntry.js` closure; `src/sdk/WorkerBoot.js` turns a module-load failure into a coded `BOOT_ERROR`.

- `design` ships as pinned CDN URLs in `client/{index,landing/index,editor/thebird-host}.html` + `scripts/bundle-client.mjs`; `vendor/*` = editing-only submodules.
- `apps/*` never imports `client/*` (singleplayer Worker resolves relative specifiers vs a virtual root); expose utilities on `engineCtx`. `apps/world/index.js` is the default-world authority.
- Node-only dynamic import specifiers stay opaque to esbuild/wrangler: IIFE, e.g. `src/sdk/EditorHandlers.js`. `edge/cf-do/spoint-do.js` imports `jolt-edge-init.js` BEFORE `WorkerEntry.js`.
- `src/protocol/msgpack.js` `_ensurePackr` builds its browser `msgpackr` specifier through an IIFE; never flatten it to a literal (esbuild: 86 KB flat vs 187 B with the IIFE).

## Browsers

- Browsing is CDP-driven and headful only. `scripts/lib/cdp-browser.mjs` (`launch`) refuses a `headless` option; every witness and tool launches through it. lightpanda, obrowser and Playwright headless are removed.

## Debugging discipline

- A bug surviving a threshold change isn't fixed; a reported cause is a claim until instrumented. Fix at its own layer end-to-end: a second copy of the same check isn't a fix (`ShapeBuilder.js`).
- **Silent-no-op class**: codesearch the reader and the enable bit first. Cases: `?noveg`, `__vdrsScale` (needs `window.__vdrs===true`), `?legacygl=1`, `u.fsCheap`, `perf-run.mjs inputReachedGame`, MICRO_JITTER. REFUTED: `--no-walk` is not a silent no-op (`const WALK = !has('no-walk')` in `perf-run.mjs` empties the movement legs, so that arm is an idle walk).
- **Silent-default class**: `Number.isFinite(x) && x > 0 ? x : literal` and `v ?? DEFAULT` turn invalid input into the default. Parse the whole record at ONE boundary and refuse there (`ColliderStreamer.js`, `src/stage/stageShapes.js`). `typeof v === 'number'` admits `1e999`.
- **No sentinel for absence**: "no ground" is a thrown `NoGroundHeightError`, never 0 or NaN; `null` compares as 0. `guardedGroundHeight(where, heightFn)` takes TWO args.
- **Refusals carry a code, not prose**: `createClusterAssigner`, `assertWorld`, `StageLoader` (`StageConfigError.reasonCode`), `TickHandlerAOI` (`position|noPosition|unknownEntity`).
- **A module-level "report once" latch leaks across in-page rebuilds** (`PlanetFrame.guardedGroundHeight`). Put the latch on the returned closure.
- **A witness that mints ids as strings never reaches the parse boundary.** Mint integers. A fixture that never stamps a sender fails every `handle()`: `senderOf` reads the symbol `stampSender` writes.
- **A bare CLI flag parses to the string `'true'`**, so `Number()` yields NaN and disables the knob it sets.
- A witness needing the server to act on a client message passes `--params=multiplayer` (`?singleplayer` sees `players:0`). One `expect()` per measurement: a harness returning uncompared `{expected, got}` passes either way.
- One `gl.getError()` code covers distinct bugs (1282 = feedback-loop, sampler-type-mismatch AND insufficient-buffer-size): read the driver's console string. Live GL: `window`/`document` only via `page.evaluate()`; pin file:line via `addInitScript`.
- A witness child that dies must surface its stderr (`scripts/lib/witness-server.mjs`).

## Entry points

- `ctx.defineGameFSM(spec)` `src/behaviours/game-fsm.js`; `ClientMachine.js` xstate5 parallel, fallback `after:` 10 s gated / 45 s hard stop. `ctx.defineFire(spec)` `src/behaviours/fire.js` (wired in `src/apps/AppContext.js`, default off).
- Test relocation: `window.__spoint` + `MSG.TELEPORT` (0xc2 / ACK 0xc3, `src/sdk/Relocation.js`; no `EDITOR_TOKEN` = any client; >87 deg refuses).
- Client `ctx.state` = entity `custom` block (`AppModuleSystem.js`), not server app state: `ctx.state.<key> ?? literal` takes the literal forever. `engine.cam` has no `position`; read `engine.client.getLocalState().position`.
- Wireweave attach helpers run after awaits (host migration reassigns `client` in `app.js`): re-check at call time. `createServer()` is a per-call factory; `boot()`'s signals are process-global: stop with `RoomDirectory.stopAll`.
- A remote server's `netcode.profile` is named only when the client is a real `PhysicsNetworkClient`: boot that witness on `?connect=...&multiplayer=1`, else in-page `BrowserServer`.

## Fire

- Integer-only kernel `fireKernel.js`: decisions from `hash(seed,step,face,I,J)`; no float, `Math.random`, `Date.now`. Per-cell step = `burnCell`.
- Rain smothers, doesn't eat fuel: a suppressed cell still burns `burnRate`, pushes no heat, spots nothing. Intensity 0..1 -> roll byte 255 via `rainPerIntensity` (`fireSpec.js`).
- `ctx.navCostAt(x,z)` = 8 burning / 2 charred (`_fireNavByRuntime`); `canSee` smoke-gated at depth >= `smokeBlockDepth`. Wind = weather BASE + `hash(seed,step)` gust, clamped +-16/axis; `snapshot().wind` carries BASE only.
- Per-cell initial fuel isn't recomputable in the kernel: a per-tile array in `snapshot()`/`restore()` joins `TILE_ARRAYS` + VERSION bump.
- A tampered keyframe is rejected at DECODE. `G` = ignition step mod 256, not age; IGNITE_AREA kind 5. `fireKeyframe.js` raises `[fireKeyframe]`; `rewindTo` verifies against `counters`, never `delta`, which at a boundary rolls back the step BEFORE it.
- A fire record promising work with no sampler is refused at construction (`src/behaviours/fireTerrain.js`): `firebreaks.kinds` defaults `['road','river']` while `kindAt` is null; `firebreaks.water` defaults true while `heightAt`/`seaLevelAt` are null.
- Weather contract (`src/behaviours/fireWeather.js parseWeather`): a `type` other than `rain` or `snow` is dry, yielding rain 0. Absent weather, a non-finite intensity and a non-array wind also yield rain 0; `reading.kind` keeps them distinct (`no-weather`, `unreadable-weather`, `dry-other`). `src/behaviours/fireWeather.js` pins this.

## Planet-wide multiplayer

- One server world per cluster, own flat chart. Jolt heap fixed at 134217728 B (`JOLT_WASM_HEAP_BYTES`, `src/shared/clusterConfig.js`), never grows; over it `new J.JoltInterface` raises `Aborted(OOM)`.
- `maxContactConstraints` under requirement drops contacts silently; `maxBodies` under population makes Jolt return body id 0, so overflow bodies share a map key and `destroy()` aborts wasm. Assignment is pure, hysteretic, 2-4 Hz.
- Collider rings: `DEFAULT_MAX_CENTERS = 192` for BOTH trunk + rock streamers; rings per connected player, never centroid; eviction farthest-first, graded by `classifyRings` (`ColliderStreamer.js`).
- Clusters are OFF in every shipped world (`apps/world/tps-game.js`, `apps/world/tutorial.js` declare `clusters: { enabled: false }`). The world-def parser refuses the mismatch both ways (`world-clusters-enabled-without-planet-radius`, `world-planet-radius-unreachable`).
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
- `AppRuntimePhysics.js` skips `e._vehicleId != null` in BOTH `_tickPhysicsLOD` and `_enforceBodyBudget`. `Math.round` of a negative height sample yields -0, which differs from +0 as `Float32Array` bits.
- `VehiclePhysics.js`: never `J.destroy` `v.constraint`/`v.tester` after `RemoveConstraint`, nor `get_mTracks()` copies after `set_mTracks`; empty `mDifferentials` = zero wheel torque.
- EDITOR_UPDATE calls `syncEntityCollider` AFTER `changeBodyType` (which removes the body and clobbers `custom._collider`). A force no body received must not become entity velocity: `runtime.applyImpulseToEntity` answers `false` for exactly that.

## Terrain and colliders

- `solveSurfaceY` tolerance absolute `1e-4` (`SURFACE_SOLVE_TOLERANCE_M`, `PlanetFrame.js`), 64-eval cap, throws `SurfaceSolveError`; past 63.6 km it returns `-(R+anchorHeight)` with no throw.
- A sampled vertex height must be a function of the vertex, not of the walk: start every solve from `renderYOnSphere(r2, 0)` (`HeightfieldStreamer.js`). Seeding from `prev + (prev - prev2)` broke this. REFUTED: 16-bit per-field quantization as the seam cause (`addHeightField` copies into wasm and never writes back).
- Baked heightfield FAIL-LOUD (`TerrainPhysics.js`): absent = silent CPU fallback; unreadable/truncated/bad-magic/stale-code throw `[baked-heightfield]`; `hashVersion`/`terrainKey`/`chartEpoch` mismatch warns + falls back.
- No terrain is FATAL: `ServerAPI.loadWorld` rethrows `[terrain] world "<id>" has no terrain`; every caller stops its server first. `elevationAtLocal(frame,x,y,z)` = exactly `|p|-radius`; `ctx.terrainHeightAt` is NOT that.
- `PlanetFrame.groundHeightLocal` caches 4096 direct-mapped slots keyed by EXACT `(x,z)` + chartEpoch; hit rate ~0.3% while walking, so a bigger cache buys under 0.07 ms/frame.
- Placement hot path has no-allocation forms: `tangentFrameInto`, `radialSlopeInto`, `quatMulF32Into`, `tangentFrameQuatInto` (`PlacementChart.js`); rock/veg `classify` use module scratch. Output is byte-identical: dump `placementsForRockChunk`/`placementsForChunk` over ~3400 chunks, compare sha256. Most remaining steady-loop allocation is the CPU height sampler (`composeHeight`, `msSnoise3` in `node_modules/mapspinner/src/height-gen.js`).
- Rock, vegetation and grass placement all wrap the anchor field with `createModelExclusionField` (`client/core/Rocks.js`, `client/core/Vegetation.js`, `client/core/Grass.js`); `client/app.js` passes `placedModels: worldConfig.entities` to all three. `ModelExclusionField.js` includes `_interior` map models, so no placed-model footprint is exempt. `scripts/rock-model-exclusion-witness.mjs` pins zero survivors for ordinary and interior models.
- The drawn-mesh mirror's near-quad select (`TerrainMeshSurface.js sync`) tests reach in chart metres: quad footprint distance to focus <= `focusRadiusM * REACH_MUL` (384 m at the shipped focus). Never test reach in face units: `u` is a tan projection. A unit box test left 87 holes in the 0-360 m rock ring at focus 240; after the chart-metre fix: 0 holes in 0-400 m at focus 240, 0 in 392-712 m at focus 240 and 450. The near-quad cache (`DEFAULT_MAX_QUADS`) must hold the disc: 128 thrashed at focus 240 (warm reads 163 ms per 13k), 512 gives 20 ms.
- `terrain.glsl`'s `snoise3`/`vnoise2`/`seaHash`/`hpfSample` take the in-cell fraction as `P-floor(P)` from ONE `floor`. Server terrain collider = ONE fixed-anchor local tangent plane (`anchorDir` default [0,1,0]): can't represent directions past ~87 deg from anchor.
- `gl-render.js sampleGroundM` is fire-and-forget async, so each call returns the PREVIOUS call's height; non-rAF callers use `sampleGroundMSync`, which poisons the next async read.
- `VegPlacement.js`/`RockPlacement.js` read climate before `surfaceOfCell` only when `climateUsesLocalXZ !== true`. Veg density must gate on painted snow, else surviving grass weight roots trees. Slope caps differ between `VegPlacement` and `GrassPlacement` (`SLOPE_MAX` 0.6 vs 0.9).
- REFUTED: `PlacementChart.js radialSlopeAt`'s 2-tap forward difference (it flips gates only where the gradient crosses `SLOPE_MAX`). Skipping a three.js attribute upload is safe only because a buffer is seeded from the whole CPU array on creation.

## Grass distance-density

- `GRASS_DENSITY` + `grassBladeEdgeM` (`src/terrain/GrassPlacement.js`) are the single source of the law: `client/core/Grass.js` selects on it and BOTH `GrassTSL.js` and `GrassMaterial.js` mirror it in the vertex stage. Editing one side alone desynchronises the fade from the instance set with no error.
- A blade's rank `q` is uniform on [0,1) and stable for the blade's life, so `q >= f(d)` removes exactly the fraction `f(d)` and which blades go is never re-chosen as the player moves.
- `f(d) = (FULL_R / d) ** P` makes the surviving population grow as R ** (2 - P) instead of R ** 2. Inside FULL_R the keep fraction and the fade are exactly 1.
- The fade is shader-side: the CPU re-decides only every `LOD_REVISIT_STEP_M` (4 m). The CPU holds each blade from `LEAD_M` before its edge (`LEAD_M` must exceed `LOD_REVISIT_STEP_M` or a blade pops), and the shader grows it over `FADE_M` metres.
- `wind.uGrassRing` carries `EDGE_CAP_M = ringRadius - EDGE_M` (where the outermost fade reaches zero), not the ring radius.
- Placement is chunk-granular and the law is not, so a bigger ring places about twice the blades it keeps; the retired frame-time witness measured `updateMsPerQuietFrame` 1.03 -> 1.71 ms. Judge a ring change on that number, not the instance count.

## Grass wind field

- `client/core/GrassWindField.js` evaluates the gust once per lattice cell (64 x 64 over 192 m, riding the camera) and both shader paths read it with one bilinear fetch. The gust is one function of world position and time, so two blades a metre apart move together; the turbulence is a ripple that travels downwind.
- Every cell must be rewritten at the frame's time. With `GRASS_WIND_FIELD_BANDS = 8` each frame refreshed 1/8 of the rows, so one frame sampled rows from up to eight different times and the wind at a fixed point jerked. `scripts/grass-wind-field-seam-witness.mjs` (run by hand: `node scripts/grass-wind-field-seam-witness.mjs`; it is in no gate, and `npm run check` runs no witnesses): jerk ratio 231 at 8 bands, 6.4 at 1 band (cap 20). The 1-band cost is per frame CPU: in Node the lattice update rises from 0.07 to 0.55 ms (+0.48 ms). The browser cost is not measured; judge it on the frame-time number, not on this Node figure.
- The lattice origin snaps to `GRASS_WIND_FIELD_SNAP_M` (24 m), bounded by the slack the extent leaves over the reach, so the lattice is not rebuilt every frame. `GRASS_WIND_FIELD_REACH_M` (77.6) and `GRASS_WIND_FIELD_DROP_MARGIN_M` (16) bracket the ring that `Grass.js` keeps before it drops a chunk.
- A recentre that moves by whole cells copies the rows it keeps (`scroll`) and writes only the exposed border. With one band, `bandWrite` rewrites every row in the same frame, so a scroll costs the exposed writes on top of a full rebuild.
- The amplitudes are the constants the shader carried before the join (`GRASS_SWAY_BASE/FLOW`, `GRASS_FLUTTER_*`); the join changes where they are evaluated, not how large they are.

## Netcode and wire

- Prediction suppresses only the blocked DIRECTION: `_reconcile` (`PredictionEngine.js`) derives `wedgeNormal` from commanded-vs-achieved motion, else `-velocity` when stopped while commanding; `characterStep.js` projects out that component alone.
- `msgpack.js` `WIRE_STRUCTURES[1]` lists exactly the 10 keys, in order (`seq,tick,serverTime,players,entities,removed,delta,dots,me,chartEpoch`), of `TickHandler.js _packPayload`. msgpackr 2.0.4 writes -0 as `0x00`; `patch-deps.mjs` excludes -0 from both integer tests. Raw ws clients mirror `COALESCE_SENTINEL` 0xff: `0xFF` then `[uint32 LE length][msgpack]`.
- MSG ids in `src/protocol/MessageTypes.js` need only be unique: `nameMap` throws at module load on a duplicate. Declaration order carries no meaning.
- `src/protocol/msgpack.js` `_ensurePackr` builds `Packr` with `NEVER` and `Unpackr` with `DECIMAL_ROUND` for `useFloat32`; `pack()` throws until `ensurePacked()` resolves. `edge/cf-do/accept-request.js` `acceptRoomRequest` accepts only WebSocket upgrades and otherwise refuses 426 `expected websocket upgrade`; `roomKeyFor` takes the `room` query param, then `SPOINT_ROOM_KEY`, then `probe-room`. `scripts/bake-minimap.mjs` refuses a non-ok `parseTerrainConfig` instead of applying a silent default. `client/core/WorkerRenderer.js` `classifyWorkerRuntimeState` resolves stopped/error/stopping/idle/hidden/live/stalled from the stopped, error, start, visibility and frame-age inputs.
- `src/protocol/InputCodec.js` `tryEncodeInputPacket` keeps the newest 8 of 10 records and reports `input_records_dropped` for the 2 oldest; `quantizeInput` clamps pitch to +-HALF_PI with `input_field_clamped` and wraps yaw with `input_field_wrapped`. `MessageTypes.js msgName(0x7fff)` returns "unknown(0x7fff)" and `isUnreliable(0x7fff)` returns false, not null.
- Wire v3 player record: 8 fields in a 22-byte bin; `[inputSequence, inputBuffer, groundNormal]` ride a per-recipient `me` block, so snapshots pack per recipient. `getSnapshot()` keys on `_version === _snapshotVersion` alone.
- `PhysicsNetworkClient.connect()` REJECTS with a named `TransportConnectError`, never `connected:false`; retry belongs in the caller (`_doReconnect`). `err.reason` is stable: `websocket-unavailable`, `-closed-before-open`, `connect-superseded`.

- With prediction off, `BaseClient` keeps the raw input in the redundancy buffer and skips the quantized encode and decode per input step, which was the largest per-frame allocation the profiler named. The packets are byte-identical either way: a field the raw input omits encodes as the zero the template supplies. Non-finite and clamped fields are still refused and reported by the same encode the prediction path uses.

## Hot swap

A module that calls `globalThis.__spointHmr?.acceptSelf?.(import.meta.url, swap)` accepts its own edits. A save reloads only that module, and `swap(next)` re-assigns each export to the freshly imported copy. Re-assigning is what makes the edit visible: an ESM import is a live binding, so importers already holding the old copy read the new code on their next call. Self-acceptance therefore costs one module fetch per save, not a page load. It re-points code only and does not rebuild state the page already built. Walking up to an ancestor acceptor cannot help, because a re-import is a new module instance that existing importers never read.

## Dev HMR bodies

- A `?hmr=` body is a pure function of the file's bytes, the version floor, and the active version of the module and each of its direct imports. `rewrite()` stamps an import only while that import's version is above the floor, so a validator must cover exactly those. A body is re-sent only when one of them moves. `Cache-Control: no-cache` forces a revalidate before every use, so a reload answers 304 and does not re-read or re-rewrite the source.
